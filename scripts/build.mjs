// Bundles the extension into dist/. Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Person segmentation for the body filters (PASCAL VOC classes, "person" is one).
  'deeplab_v3.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite',
};
const modelDir = path.join(root, 'assets');
const wasmDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

// Models are downloaded once at build time and shipped inside the extension.
async function ensureModels() {
  for (const [name, url] of Object.entries(MODELS)) {
    const file = path.join(modelDir, name);
    try {
      await fs.access(file);
      continue;
    } catch {}
    console.log(`Downloading model from ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
}

async function copyStatic() {
  await fs.mkdir(path.join(dist, 'wasm'), { recursive: true });
  await fs.mkdir(path.join(dist, 'models'), { recursive: true });
  await fs.cp(path.join(root, 'src', 'icons'), path.join(dist, 'icons'), { recursive: true });
  await fs.cp(path.join(root, 'src', 'fonts'), path.join(dist, 'fonts'), { recursive: true });
  const copies = [
    ['src/manifest.json', 'manifest.json'],
    ['src/popup.html', 'popup.html'],
    ['src/popup.css', 'popup.css'],
    ['src/upload.html', 'upload.html'],
    ['src/upload.css', 'upload.css'],
    [path.join(wasmDir, 'vision_wasm_internal.js'), 'wasm/vision_wasm_internal.js'],
    [path.join(wasmDir, 'vision_wasm_internal.wasm'), 'wasm/vision_wasm_internal.wasm'],
    ...Object.keys(MODELS).map((name) => [path.join(modelDir, name), `models/${name}`]),
  ];
  await Promise.all(copies.map(([from, to]) => fs.copyFile(path.resolve(root, from), path.join(dist, to))));
}

await ensureModels();
await fs.rm(dist, { recursive: true, force: true });
await copyStatic();

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background.js',
    content: 'src/content.js',
    popup: 'src/popup.js',
    upload: 'src/upload.js',
  },
  outdir: dist,
  bundle: true,
  // Inline SVG icons (popup) as strings.
  loader: { '.svg': 'text' },
  format: 'iife',
  target: 'chrome116',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  plugins: [
    {
      name: 'copy-static',
      setup(build) {
        build.onEnd(() => copyStatic());
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
