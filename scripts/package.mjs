// Builds and zips dist/ for upload to the Chrome Web Store.
// Usage: npm run package  ->  release/face-hack-<version>.zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'src', 'manifest.json'), 'utf8'));

execFileSync('node', [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });

const releaseDir = path.join(root, 'release');
const zip = path.join(releaseDir, `face-hack-${version}.zip`);
fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(zip, { force: true });
// Zip the contents of dist/ so manifest.json sits at the root of the archive.
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: path.join(root, 'dist'), stdio: 'inherit' });
const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\n${path.relative(root, zip)} (${mb} MB)`);
