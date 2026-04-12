import VERT_SRC from './shaders/vert.glsl?raw';
import FRAG_SRC from './shaders/frag.glsl?raw';

const canvas = document.getElementById('c');
const modeSelect = document.getElementById('mode');
const yRealInput = document.getElementById('y-real');
const yImagInput = document.getElementById('y-imag');
const renderWidthInput = document.getElementById('render-width');
const renderHeightInput = document.getElementById('render-height');
const sinkItersInput = document.getElementById('sink-iters');
const dfsDepthInput = document.getElementById('dfs-depth');
const dfsVisitsInput = document.getElementById('dfs-visits');
const applyResolutionButton = document.getElementById('apply-resolution');
const resetViewButton = document.getElementById('reset-view');
const exportPpmButton = document.getElementById('export-ppm');
const status = document.getElementById('status');

const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });

if (!gl) {
  document.body.textContent = 'WebGL2 not supported';
  throw new Error('WebGL2 not supported');
}

const DEFAULT_VIEW = {
  offsetX: 1.975,
  offsetY: 6.025,
};
const DEFAULT_RENDER_WIDTH = 640;
const DEFAULT_RENDER_HEIGHT = 640;
const DEFAULT_WORLD_SPAN = 16;

function defaultScaleForResolution(width, height) {
  return Math.max(1, Math.min(width, height) / DEFAULT_WORLD_SPAN);
}

let offsetX = DEFAULT_VIEW.offsetX;
let offsetY = DEFAULT_VIEW.offsetY;
let scale = defaultScaleForResolution(DEFAULT_RENDER_WIDTH, DEFAULT_RENDER_HEIGHT);
let yReal = Number(yRealInput.value);
let yImag = Number(yImagInput.value);
let mode = Number(modeSelect.value);
let maxSinkIters = Number(sinkItersInput.value);
let maxDfsDepth = Number(dfsDepthInput.value);
let maxDfsVisits = Number(dfsVisitsInput.value);
const searchParams = new URLSearchParams(window.location.search);
let lastCpuRenderMs = 0;
let lastGpuRenderMs = null;
let frameCounter = 0;
let fpsWindowStart = performance.now();
let fps = 0;
const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
let pendingTimerQuery = null;

function parseFiniteParam(name, fallback) {
  const raw = searchParams.get(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseIntParam(name, fallback) {
  const raw = searchParams.get(name);
  if (raw == null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function applyStateToInputs() {
  yRealInput.value = String(yReal);
  yImagInput.value = String(yImag);
  modeSelect.value = String(mode);
  renderWidthInput.value = String(
    Number.parseInt(renderWidthInput.value, 10) || parseIntParam('width', DEFAULT_RENDER_WIDTH),
  );
  renderHeightInput.value = String(
    Number.parseInt(renderHeightInput.value, 10) || parseIntParam('height', DEFAULT_RENDER_HEIGHT),
  );
  sinkItersInput.value = String(maxSinkIters);
  dfsDepthInput.value = String(maxDfsDepth);
  dfsVisitsInput.value = String(maxDfsVisits);
}

function applyParamsFromUrl() {
  const resolvedWidth = parseIntParam('width', Number(renderWidthInput.value) || DEFAULT_RENDER_WIDTH);
  const resolvedHeight = parseIntParam(
    'height',
    Number(renderHeightInput.value) || DEFAULT_RENDER_HEIGHT,
  );
  yReal = parseFiniteParam('yReal', yReal);
  yImag = parseFiniteParam('yImag', yImag);
  mode = parseIntParam('mode', mode);
  offsetX = parseFiniteParam('offsetX', offsetX);
  offsetY = parseFiniteParam('offsetY', offsetY);
  scale = parseFiniteParam('scale', defaultScaleForResolution(resolvedWidth, resolvedHeight));
  maxSinkIters = parseIntParam('sinkIters', maxSinkIters);
  maxDfsDepth = parseIntParam('dfsDepth', maxDfsDepth);
  maxDfsVisits = parseIntParam('dfsVisits', maxDfsVisits);

  renderWidthInput.value = String(resolvedWidth);
  renderHeightInput.value = String(resolvedHeight);
  applyStateToInputs();
}

function applyResolution() {
  const width = Math.max(1, Number.parseInt(renderWidthInput.value, 10) || DEFAULT_RENDER_WIDTH);
  const height = Math.max(1, Number.parseInt(renderHeightInput.value, 10) || DEFAULT_RENDER_HEIGHT);
  renderWidthInput.value = String(width);
  renderHeightInput.value = String(height);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  gl.viewport(0, 0, width, height);
  updateStatus('canvas display size matches the render buffer');
}

// -- shaders ------------------------------------------------------------------

function compileShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function linkProgram(vert, frag) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

const prog = linkProgram(
  compileShader(gl.VERTEX_SHADER, VERT_SRC),
  compileShader(gl.FRAGMENT_SHADER, FRAG_SRC),
);
gl.useProgram(prog);

// -- fullscreen quad ----------------------------------------------------------

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
  gl.STATIC_DRAW,
);

const aPos = gl.getAttribLocation(prog, 'a_pos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

// -- uniforms -----------------------------------------------------------------

const uResolution = gl.getUniformLocation(prog, 'u_resolution');
const uOffset = gl.getUniformLocation(prog, 'u_offset');
const uScale = gl.getUniformLocation(prog, 'u_scale');
const uY = gl.getUniformLocation(prog, 'u_y');
const uMode = gl.getUniformLocation(prog, 'u_mode');
const uMaxSinkIters = gl.getUniformLocation(prog, 'u_max_sink_iters');
const uMaxDfsDepth = gl.getUniformLocation(prog, 'u_max_dfs_depth');
const uMaxDfsVisits = gl.getUniformLocation(prog, 'u_max_dfs_visits');

// -- interaction --------------------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;

function cssDeltaToBufferDelta(dx, dy) {
  const rect = canvas.getBoundingClientRect();
  return {
    dx: rect.width > 0 ? (dx * canvas.width) / rect.width : dx,
    dy: rect.height > 0 ? (dy * canvas.height) / rect.height : dy,
  };
}

function updateStatus(message = '') {
  status.textContent = [
    `resolution: ${canvas.width} x ${canvas.height}`,
    `offset: (${offsetX.toFixed(3)}, ${offsetY.toFixed(3)})`,
    `scale: ${scale.toFixed(3)} px/unit`,
    `y: ${yReal.toFixed(3)} + ${yImag.toFixed(3)}i`,
    `sink/dfs: ${maxSinkIters} / ${maxDfsDepth} / ${maxDfsVisits}`,
    `cpu: ${lastCpuRenderMs.toFixed(2)} ms, gpu: ${lastGpuRenderMs == null ? 'n/a' : `${lastGpuRenderMs.toFixed(2)} ms`}, fps: ${fps.toFixed(1)}`,
    message,
  ]
    .filter(Boolean)
    .join('\n');
}

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});

window.addEventListener('mouseup', () => {
  dragging = false;
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const { dx, dy } = cssDeltaToBufferDelta(e.clientX - lastX, e.clientY - lastY);
  offsetX -= dx / scale;
  offsetY += dy / scale;
  lastX = e.clientX;
  lastY = e.clientY;
  updateStatus();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    scale *= factor;
    updateStatus();
  },
  { passive: false },
);

applyResolutionButton.addEventListener('click', applyResolution);

resetViewButton.addEventListener('click', () => {
  offsetX = DEFAULT_VIEW.offsetX;
  offsetY = DEFAULT_VIEW.offsetY;
  scale = defaultScaleForResolution(canvas.width, canvas.height);
  updateStatus('view reset to match the BQ.py default window');
});

modeSelect.addEventListener('change', () => {
  mode = Number(modeSelect.value);
  updateStatus();
});

for (const input of [yRealInput, yImagInput]) {
  input.addEventListener('input', () => {
    yReal = Number(yRealInput.value);
    yImag = Number(yImagInput.value);
    updateStatus();
  });
}

for (const input of [sinkItersInput, dfsDepthInput, dfsVisitsInput]) {
  input.addEventListener('input', () => {
    maxSinkIters = Math.max(1, Number.parseInt(sinkItersInput.value, 10) || 32);
    maxDfsDepth = Math.max(1, Number.parseInt(dfsDepthInput.value, 10) || 64);
    maxDfsVisits = Math.max(1, Number.parseInt(dfsVisitsInput.value, 10) || 320);
    applyStateToInputs();
    updateStatus();
  });
}

function beginGpuTimer() {
  if (!timerExt || pendingTimerQuery) return;
  const query = gl.createQuery();
  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
  pendingTimerQuery = query;
}

function endGpuTimer() {
  if (!timerExt || !pendingTimerQuery) return;
  gl.endQuery(timerExt.TIME_ELAPSED_EXT);
}

function pollGpuTimer() {
  if (!timerExt || !pendingTimerQuery) return;
  const available = gl.getQueryParameter(pendingTimerQuery, gl.QUERY_RESULT_AVAILABLE);
  const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
  if (!available || disjoint) return;
  const elapsedNs = gl.getQueryParameter(pendingTimerQuery, gl.QUERY_RESULT);
  lastGpuRenderMs = elapsedNs / 1e6;
  gl.deleteQuery(pendingTimerQuery);
  pendingTimerQuery = null;
}

async function waitForGpuTimer() {
  if (!timerExt || !pendingTimerQuery) return;
  for (let attempt = 0; attempt < 12 && pendingTimerQuery; attempt += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    pollGpuTimer();
  }
}

function render() {
  const cpuStart = performance.now();
  beginGpuTimer();
  gl.uniform2f(uResolution, canvas.width, canvas.height);
  gl.uniform2f(uOffset, offsetX, offsetY);
  gl.uniform1f(uScale, scale);
  gl.uniform2f(uY, yReal, yImag);
  gl.uniform1i(uMode, mode);
  gl.uniform1i(uMaxSinkIters, maxSinkIters);
  gl.uniform1i(uMaxDfsDepth, maxDfsDepth);
  gl.uniform1i(uMaxDfsVisits, maxDfsVisits);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  endGpuTimer();
  lastCpuRenderMs = performance.now() - cpuStart;
}

function renderOnce() {
  render();
  gl.finish();
}

function getState() {
  return {
    width: canvas.width,
    height: canvas.height,
    mode,
    yReal,
    yImag,
    offsetX,
    offsetY,
    scale,
    maxSinkIters,
    maxDfsDepth,
    maxDfsVisits,
    lastCpuRenderMs,
    lastGpuRenderMs,
  };
}

function buildCurrentFramePpm() {
  renderOnce();

  const width = canvas.width;
  const height = canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const lines = ['P3', `${width} ${height}`, '255'];
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      row.push(`${pixels[index]} ${pixels[index + 1]} ${pixels[index + 2]}`);
    }
    lines.push(row.join(' '));
  }

  return `${lines.join('\n')}\n`;
}

function exportCurrentFrameAsPpm() {
  const ppm = buildCurrentFramePpm();
  const blob = new Blob([ppm], { type: 'image/x-portable-pixmap' });
  const link = document.createElement('a');
  const filename = `maskit-${canvas.width}x${canvas.height}-mode${mode}.ppm`;
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

  updateStatus(`exported ${filename}`);
}

exportPpmButton.addEventListener('click', exportCurrentFrameAsPpm);

function setParams(params = {}) {
  if (typeof params.yReal === 'number') yReal = params.yReal;
  if (typeof params.yImag === 'number') yImag = params.yImag;
  if (typeof params.mode === 'number') mode = params.mode;
  if (typeof params.offsetX === 'number') offsetX = params.offsetX;
  if (typeof params.offsetY === 'number') offsetY = params.offsetY;
  if (typeof params.scale === 'number') scale = params.scale;
  if (typeof params.maxSinkIters === 'number') maxSinkIters = params.maxSinkIters;
  if (typeof params.maxDfsDepth === 'number') maxDfsDepth = params.maxDfsDepth;
  if (typeof params.maxDfsVisits === 'number') maxDfsVisits = params.maxDfsVisits;
  if (typeof params.width === 'number')
    renderWidthInput.value = String(Math.max(1, Math.round(params.width)));
  if (typeof params.height === 'number')
    renderHeightInput.value = String(Math.max(1, Math.round(params.height)));

  applyResolution();
  applyStateToInputs();
}

window.__maskitTest = {
  setParams,
  renderOnce: async () => {
    const wallStart = performance.now();
    renderOnce();
    await waitForGpuTimer();
    return {
      ...getState(),
      wallRenderMs: performance.now() - wallStart,
    };
  },
  exportPpm: () => buildCurrentFramePpm(),
  getState,
  resetView: () => {
    offsetX = DEFAULT_VIEW.offsetX;
    offsetY = DEFAULT_VIEW.offsetY;
    scale = defaultScaleForResolution(canvas.width, canvas.height);
    applyStateToInputs();
    updateStatus('view reset to match the BQ.py default window');
  },
};

function frame() {
  render();
  pollGpuTimer();
  frameCounter += 1;
  const now = performance.now();
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 500) {
    fps = (frameCounter * 1000) / elapsed;
    frameCounter = 0;
    fpsWindowStart = now;
    updateStatus();
  }
  requestAnimationFrame(frame);
}

applyParamsFromUrl();
applyResolution();
updateStatus('drag to pan, wheel to zoom');
requestAnimationFrame(frame);
