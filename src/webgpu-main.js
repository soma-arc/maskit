import { buildPpmFromRgba, downloadPpm } from './ppm-export.js';
import { createWebgpuRenderer } from './renderers/webgpu.js';
import {
    applyCanvasResolution,
    buildStatusText,
    getViewerElements,
    sanitizeResolutionFromInputs,
    syncInputsWithState,
} from './ui.js';
import {
    createInitialViewerState,
    DEFAULT_VIEW,
    defaultScaleForResolution,
} from './viewer-state.js';

const elements = getViewerElements();
const { canvas } = elements;
const searchParams = new URLSearchParams(window.location.search);
const isAutomation = searchParams.get('automation') === '1';
const state = createInitialViewerState(elements, searchParams);

let renderer;
let frameCounter = 0;
let fpsWindowStart = performance.now();
let fps = 0;

function updateStatus(message = '') {
    if (!renderer) {
        elements.status.textContent = message;
        return;
    }

    elements.status.textContent = buildStatusText({
        state,
        timing: renderer.getTiming(),
        fps,
        message,
    });
}

function applyResolution() {
    syncInputsWithState(elements, state);
    applyCanvasResolution(canvas, state.width, state.height);
    renderer.setViewport(state.width, state.height);
    updateStatus('canvas display size matches the render buffer');
}

function cssDeltaToBufferDelta(dx, dy) {
    const rect = canvas.getBoundingClientRect();
    return {
        dx: rect.width > 0 ? (dx * canvas.width) / rect.width : dx,
        dy: rect.height > 0 ? (dy * canvas.height) / rect.height : dy,
    };
}

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('mousedown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
});

window.addEventListener('mouseup', () => {
    dragging = false;
});

window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const { dx, dy } = cssDeltaToBufferDelta(event.clientX - lastX, event.clientY - lastY);
    state.offsetX -= dx / state.scale;
    state.offsetY += dy / state.scale;
    lastX = event.clientX;
    lastY = event.clientY;
    updateStatus();
});

canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        state.scale *= factor;
        updateStatus();
    },
    { passive: false },
);

elements.applyResolutionButton.addEventListener('click', () => {
    sanitizeResolutionFromInputs(elements, state);
    applyResolution();
});

elements.resetViewButton.addEventListener('click', () => {
    state.offsetX = DEFAULT_VIEW.offsetX;
    state.offsetY = DEFAULT_VIEW.offsetY;
    state.scale = defaultScaleForResolution(state.width, state.height);
    updateStatus('view reset to match the BQ.py default window');
});

elements.modeSelect.addEventListener('change', () => {
    state.mode = Number(elements.modeSelect.value);
    updateStatus();
});

for (const input of [elements.yRealInput, elements.yImagInput]) {
    input.addEventListener('input', () => {
        state.yReal = Number(elements.yRealInput.value);
        state.yImag = Number(elements.yImagInput.value);
        updateStatus();
    });
}

for (const input of [elements.sinkItersInput, elements.dfsDepthInput, elements.dfsVisitsInput]) {
    input.addEventListener('input', () => {
        state.maxSinkIters = Math.max(1, Number.parseInt(elements.sinkItersInput.value, 10) || 32);
        state.maxDfsDepth = Math.max(1, Number.parseInt(elements.dfsDepthInput.value, 10) || 64);
        state.maxDfsVisits = Math.max(1, Number.parseInt(elements.dfsVisitsInput.value, 10) || 320);
        syncInputsWithState(elements, state);
        updateStatus();
    });
}

async function buildCurrentFramePpm() {
    const pixels = await renderer.readPixels(state);
    return buildPpmFromRgba(state.width, state.height, pixels);
}

elements.exportPpmButton.addEventListener('click', async () => {
    const ppm = await buildCurrentFramePpm();
    const filename = `maskit-webgpu-${state.width}x${state.height}-mode${state.mode}.ppm`;
    downloadPpm(ppm, filename);
    updateStatus(`exported ${filename}`);
});

function getState() {
    return {
        ...state,
        ...renderer.getTiming(),
    };
}

function setParams(params = {}) {
    if (typeof params.yReal === 'number') state.yReal = params.yReal;
    if (typeof params.yImag === 'number') state.yImag = params.yImag;
    if (typeof params.mode === 'number') state.mode = params.mode;
    if (typeof params.offsetX === 'number') state.offsetX = params.offsetX;
    if (typeof params.offsetY === 'number') state.offsetY = params.offsetY;
    if (typeof params.scale === 'number') state.scale = params.scale;
    if (typeof params.maxSinkIters === 'number') state.maxSinkIters = params.maxSinkIters;
    if (typeof params.maxDfsDepth === 'number') state.maxDfsDepth = params.maxDfsDepth;
    if (typeof params.maxDfsVisits === 'number') state.maxDfsVisits = params.maxDfsVisits;
    if (typeof params.width === 'number') state.width = Math.max(1, Math.round(params.width));
    if (typeof params.height === 'number') state.height = Math.max(1, Math.round(params.height));

    syncInputsWithState(elements, state);
    applyResolution();
}

function installAutomationApi() {
    window.__maskitTest = {
        setParams,
        renderOnce: async () => {
            const wallStart = performance.now();
            await renderer.renderOnce(state);
            return {
                ...getState(),
                wallRenderMs: performance.now() - wallStart,
            };
        },
        exportPpm: async () => buildCurrentFramePpm(),
        getState,
        resetView: () => {
            state.offsetX = DEFAULT_VIEW.offsetX;
            state.offsetY = DEFAULT_VIEW.offsetY;
            state.scale = defaultScaleForResolution(state.width, state.height);
            syncInputsWithState(elements, state);
            updateStatus('view reset to match the BQ.py default window');
        },
    };
}

function frame() {
    renderer.render(state);
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

async function main() {
    try {
        renderer = await createWebgpuRenderer({ canvas });
    } catch (error) {
        document.body.textContent = 'WebGPU not supported';
        throw error;
    }

    syncInputsWithState(elements, state);
    applyResolution();
    installAutomationApi();
    updateStatus('WebGPU preview ready');
    if (!isAutomation) {
        requestAnimationFrame(frame);
    }
}

main().catch((error) => {
    console.error(error);
});
