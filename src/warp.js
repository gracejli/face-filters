// Face distortion (fisheye, big eyes, pinch) with one shared WebGL2 context.
//
// Each element's overlay is a 2D canvas, and Chrome caps how many WebGL
// contexts a page may hold, so instead of one GL canvas per overlay we render
// into a single OffscreenCanvas and the caller copies the result over with
// drawImage.
//
// A bulge is {x, y, r, s} in source pixels: centre, radius, strength. Inside
// the radius each output pixel samples from closer to (s > 0, magnify) or
// further from (s < 0, shrink) the centre. The displacement fades to zero at
// the edge, so the warped region blends seamlessly into the original image.

export const MAX_BULGES = 16;

const VERT = `#version 300 es
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  // uv (0,0) is the top-left of the output; clip space has +y up.
  gl_Position = vec4(a_uv.x * 2.0 - 1.0, 1.0 - a_uv.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec4 u_bulge[${MAX_BULGES}];
uniform int u_count;
in vec2 v_uv;
out vec4 color;
void main() {
  vec2 p = v_uv * u_size;
  for (int i = 0; i < ${MAX_BULGES}; i++) {
    if (i >= u_count) break;
    vec4 b = u_bulge[i];
    vec2 d = p - b.xy;
    float dist = length(d) / b.z;
    if (dist < 1.0) {
      float falloff = 1.0 - dist * dist;
      p = b.xy + d * (1.0 - b.w * falloff * falloff);
    }
  }
  color = texture(u_src, clamp(p / u_size, 0.0, 1.0));
}`;

let gl = null;
let canvas = null;
let locs = null;
let failed = false;

function init() {
  canvas = new OffscreenCanvas(1, 1);
  gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('WebGL2 unavailable');

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const aUv = gl.getAttribLocation(prog, 'a_uv');
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  locs = {
    size: gl.getUniformLocation(prog, 'u_size'),
    bulge: gl.getUniformLocation(prog, 'u_bulge'),
    count: gl.getUniformLocation(prog, 'u_count'),
  };
}

/**
 * Render `source` (ImageBitmap or <video>) warped by `bulges` at outW×outH.
 * Returns the OffscreenCanvas to drawImage from, or null if WebGL is
 * unavailable. The canvas is reused, so copy from it before the next call.
 */
export function renderWarp(source, srcW, srcH, outW, outH, bulges) {
  if (failed) return null;
  try {
    if (!gl || gl.isContextLost()) init();
  } catch (err) {
    failed = true;
    console.debug('[face-hack] warp disabled', err);
    return null;
  }
  if (canvas.width !== outW || canvas.height !== outH) {
    canvas.width = outW;
    canvas.height = outH;
  }
  gl.viewport(0, 0, outW, outH);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  const data = new Float32Array(MAX_BULGES * 4);
  const n = Math.min(bulges.length, MAX_BULGES);
  for (let i = 0; i < n; i++) data.set([bulges[i].x, bulges[i].y, bulges[i].r, bulges[i].s], i * 4);
  gl.uniform2f(locs.size, srcW, srcH);
  gl.uniform4fv(locs.bulge, data);
  gl.uniform1i(locs.count, n);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
