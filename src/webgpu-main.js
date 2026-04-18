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

const GPU_COMPARE_MODE = 5;
const HYBRID_COMPARE_MODE = 7;
const UNKNOWN_HIGHLIGHT_MODE = 6;

const elements = getViewerElements();
const { canvas, hybridCanvas } = elements;
const hybridContext = hybridCanvas.getContext('2d');
const searchParams = new URLSearchParams(window.location.search);
const isAutomation = searchParams.get('automation') === '1';
const state = createInitialViewerState(elements, searchParams);
const hybridWorker = new Worker(new URL('./workers/bq-refine-worker.js', import.meta.url), {
    type: 'module',
});

let renderer;
let fps = 0;
let statusMessage = '';
let hybridRefreshPromise = null;
let hybridRefreshPending = false;
let hybridWorkerRequestId = 0;
let renderScheduled = false;
let lastRenderTimestamp = 0;

const hybridWorkerRequests = new Map();

const hybridFrame = {
    signature: null,
    ppm: null,
    refinement: null,
};

hybridWorker.addEventListener('message', (event) => {
    const { requestId, refinedMaskBuffer, resolvedCount, resolvedTrue, resolvedFalse, error } =
        event.data;
    const pending = hybridWorkerRequests.get(requestId);
    if (!pending) {
        return;
    }

    hybridWorkerRequests.delete(requestId);

    if (error) {
        pending.reject(new Error(error));
        return;
    }

    pending.resolve({
        refinedMask: new Uint8Array(refinedMaskBuffer),
        resolvedCount,
        resolvedTrue,
        resolvedFalse,
    });
});

function getRendererState(viewState) {
    if (viewState.mode !== HYBRID_COMPARE_MODE) {
        return viewState;
    }

    return {
        ...viewState,
        mode: viewState.showGpuUnknown ? UNKNOWN_HIGHLIGHT_MODE : GPU_COMPARE_MODE,
    };
}

function isHybridRefineEnabled(viewState) {
    return viewState.mode === HYBRID_COMPARE_MODE;
}

function getHybridSignature(viewState) {
    return JSON.stringify({
        width: viewState.width,
        height: viewState.height,
        offsetX: viewState.offsetX,
        offsetY: viewState.offsetY,
        scale: viewState.scale,
        yReal: viewState.yReal,
        yImag: viewState.yImag,
        maxSinkIters: viewState.maxSinkIters,
        maxDfsDepth: viewState.maxDfsDepth,
        maxDfsVisits: viewState.maxDfsVisits,
        showGpuUnknown: viewState.showGpuUnknown,
    });
}

function setStatusMessage(message = '') {
    statusMessage = message;
    updateStatus();
}

function scheduleRender() {
    if (!renderer || isAutomation || renderScheduled) {
        return;
    }

    renderScheduled = true;
    requestAnimationFrame((now) => {
        renderScheduled = false;
        renderer.render(getRendererState(state));
        if (lastRenderTimestamp > 0) {
            const deltaMs = now - lastRenderTimestamp;
            fps = deltaMs > 0 ? 1000 / deltaMs : 0;
        }
        lastRenderTimestamp = now;
        updateStatus();
    });
}

function updateStatus() {
    if (!renderer) {
        elements.status.textContent = statusMessage;
        return;
    }

    elements.status.textContent = buildStatusText({
        state,
        timing: renderer.getTiming(),
        fps,
        message: statusMessage,
    });
}

function hideHybridCanvas() {
    hybridCanvas.style.display = 'none';
    hybridContext.clearRect(0, 0, hybridCanvas.width, hybridCanvas.height);
}

function syncHybridCanvasVisibility() {
    const shouldShow =
        isHybridRefineEnabled(state) &&
        hybridFrame.signature === getHybridSignature(state) &&
        hybridFrame.ppm != null;

    hybridCanvas.style.display = shouldShow ? 'block' : 'none';
    if (!shouldShow) {
        hideHybridCanvas();
    }
}

function buildBinaryMaskFromRgba(width, height, pixels) {
    const mask = new Uint8Array(width * height);
    for (let outputY = 0; outputY < height; outputY += 1) {
        const sourceY = height - 1 - outputY;
        for (let x = 0; x < width; x += 1) {
            const sourceIndex = (sourceY * width + x) * 4;
            const maskIndex = outputY * width + x;
            const luminance =
                (pixels[sourceIndex] + pixels[sourceIndex + 1] + pixels[sourceIndex + 2]) / 3;
            mask[maskIndex] = luminance < 127.5 ? 1 : 0;
        }
    }
    return mask;
}

function buildUnknownOverlayFromRefinedMask(width, height, refinedMask, unknownPixels) {
    const pixels = new Uint8Array(width * height * 4);
    for (const pixel of unknownPixels) {
        const maskIndex = (height - 1 - pixel.y) * width + pixel.x;
        const channel = refinedMask[maskIndex] === 1 ? 0 : 255;
        const rgbaIndex = (pixel.y * width + pixel.x) * 4;
        pixels[rgbaIndex] = channel;
        pixels[rgbaIndex + 1] = channel;
        pixels[rgbaIndex + 2] = channel;
        pixels[rgbaIndex + 3] = 255;
    }
    return pixels;
}

function buildPpmFromBinaryMask(width, height, mask) {
    const lines = ['P3', `${width} ${height}`, '255'];
    for (let y = 0; y < height; y += 1) {
        const row = [];
        for (let x = 0; x < width; x += 1) {
            const channel = mask[y * width + x] === 1 ? 0 : 255;
            row.push(`${channel} ${channel} ${channel}`);
        }
        lines.push(row.join(' '));
    }
    return `${lines.join('\n')}\n`;
}

function refineUnknownMaskInWorker(renderState, candidateMask, unknownPixels, options) {
    const requestId = hybridWorkerRequestId;
    hybridWorkerRequestId += 1;
    const candidateMaskBuffer = candidateMask.buffer.slice(0);

    return new Promise((resolve, reject) => {
        hybridWorkerRequests.set(requestId, { resolve, reject });
        hybridWorker.postMessage(
            {
                requestId,
                renderState,
                candidateMaskBuffer,
                unknownPixels,
                options,
            },
            [candidateMaskBuffer],
        );
    });
}

function drawHybridFrame(width, height, pixels) {
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    hybridContext.putImageData(imageData, 0, 0);
    hybridCanvas.style.display = 'block';
}

async function buildHybridFrame(viewState) {
    const renderState = getRendererState(viewState);
    const [pixels, unknownPayload] = await Promise.all([
        renderer.readPixels(renderState),
        renderer.readUnknownPixelIndices(renderState, renderState.width * renderState.height),
    ]);
    const candidateMask = buildBinaryMaskFromRgba(renderState.width, renderState.height, pixels);
    const refined = await refineUnknownMaskInWorker(
        renderState,
        candidateMask,
        unknownPayload.indices,
        {
            maxSinkIters: 1_000_000,
            maxDepth: 995,
        },
    );
    const hybridPixels = buildUnknownOverlayFromRefinedMask(
        renderState.width,
        renderState.height,
        refined.refinedMask,
        unknownPayload.indices,
    );
    const ppm = buildPpmFromBinaryMask(renderState.width, renderState.height, refined.refinedMask);

    return {
        signature: getHybridSignature(renderState),
        ppm,
        pixels: hybridPixels,
        refinement: {
            unknownCount: unknownPayload.unknownCount,
            refinedPixelCount: refined.resolvedCount,
            resolvedTrue: refined.resolvedTrue,
            resolvedFalse: refined.resolvedFalse,
        },
    };
}

async function ensureHybridFrame(force = false) {
    if (!isHybridRefineEnabled(state)) {
        syncHybridCanvasVisibility();
        return null;
    }

    const signature = getHybridSignature(state);
    if (!force && hybridFrame.signature === signature && hybridFrame.ppm) {
        syncHybridCanvasVisibility();
        return hybridFrame;
    }

    const nextFrame = await buildHybridFrame(state);
    hybridFrame.signature = nextFrame.signature;
    hybridFrame.ppm = nextFrame.ppm;
    hybridFrame.refinement = nextFrame.refinement;
    drawHybridFrame(state.width, state.height, nextFrame.pixels);
    syncHybridCanvasVisibility();
    setStatusMessage(
        `hybrid: refined ${nextFrame.refinement.refinedPixelCount} unresolved pixels (${nextFrame.refinement.resolvedTrue} -> true, ${nextFrame.refinement.resolvedFalse} -> false)`,
    );
    return hybridFrame;
}

async function flushHybridRefreshQueue() {
    while (hybridRefreshPending) {
        hybridRefreshPending = false;
        try {
            await ensureHybridFrame(true);
        } catch (error) {
            hideHybridCanvas();
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`hybrid error: ${message}`);
        }
    }
    hybridRefreshPromise = null;
}

function requestHybridRefresh() {
    hybridRefreshPending = true;
    syncHybridCanvasVisibility();
    if (!hybridRefreshPromise) {
        setStatusMessage('hybrid: refining unresolved pixels in browser');
        hybridRefreshPromise = flushHybridRefreshQueue();
    }
}

function applyResolution() {
    syncInputsWithState(elements, state);
    applyCanvasResolution(canvas, state.width, state.height);
    applyCanvasResolution(hybridCanvas, state.width, state.height);
    renderer.setViewport(state.width, state.height);
    hybridFrame.signature = null;
    hybridFrame.ppm = null;
    hybridFrame.refinement = null;
    syncHybridCanvasVisibility();
    setStatusMessage('canvas display size matches the render buffer');
}

function requestHybridRefreshIfNeeded() {
    scheduleRender();
    if (isHybridRefineEnabled(state)) {
        requestHybridRefresh();
    } else {
        syncHybridCanvasVisibility();
    }
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
    state.offsetY -= dy / state.scale;
    lastX = event.clientX;
    lastY = event.clientY;
    requestHybridRefreshIfNeeded();
    updateStatus();
});

canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        state.scale *= factor;
        requestHybridRefreshIfNeeded();
        updateStatus();
    },
    { passive: false },
);

elements.applyResolutionButton.addEventListener('click', () => {
    sanitizeResolutionFromInputs(elements, state);
    applyResolution();
    requestHybridRefreshIfNeeded();
});

elements.resetViewButton.addEventListener('click', () => {
    state.offsetX = DEFAULT_VIEW.offsetX;
    state.offsetY = DEFAULT_VIEW.offsetY;
    state.scale = defaultScaleForResolution(state.width, state.height);
    requestHybridRefreshIfNeeded();
    setStatusMessage('view reset to match the BQ.py default window');
});

elements.modeSelect.addEventListener('change', () => {
    state.mode = Number(elements.modeSelect.value);
    syncInputsWithState(elements, state);
    requestHybridRefreshIfNeeded();
    updateStatus();
});

for (const input of [elements.yRealInput, elements.yImagInput]) {
    input.addEventListener('input', () => {
        state.yReal = Number(elements.yRealInput.value);
        state.yImag = Number(elements.yImagInput.value);
        requestHybridRefreshIfNeeded();
        updateStatus();
    });
}

for (const input of [elements.sinkItersInput, elements.dfsDepthInput, elements.dfsVisitsInput]) {
    input.addEventListener('input', () => {
        state.maxSinkIters = Math.max(1, Number.parseInt(elements.sinkItersInput.value, 10) || 64);
        state.maxDfsDepth = Math.max(1, Number.parseInt(elements.dfsDepthInput.value, 10) || 320);
        state.maxDfsVisits = Math.max(
            1,
            Number.parseInt(elements.dfsVisitsInput.value, 10) || 8192,
        );
        syncInputsWithState(elements, state);
        requestHybridRefreshIfNeeded();
        updateStatus();
    });
}

elements.showGpuUnknownInput.addEventListener('change', () => {
    state.showGpuUnknown = elements.showGpuUnknownInput.checked;
    requestHybridRefreshIfNeeded();
    updateStatus();
});

async function buildCurrentFramePpm() {
    if (isHybridRefineEnabled(state)) {
        const frame = await ensureHybridFrame();
        return frame?.ppm ?? '';
    }

    const pixels = await renderer.readPixels(getRendererState(state));
    return buildPpmFromRgba(state.width, state.height, pixels);
}

elements.exportPpmButton.addEventListener('click', async () => {
    const ppm = await buildCurrentFramePpm();
    const filename = `maskit-webgpu-${state.width}x${state.height}-mode${state.mode}.ppm`;
    downloadPpm(ppm, filename);
    setStatusMessage(`exported ${filename}`);
});

function getState() {
    return {
        ...state,
        ...renderer.getTiming(),
        hybrid: hybridFrame.refinement,
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
    if (typeof params.showGpuUnknown === 'boolean') {
        state.showGpuUnknown = params.showGpuUnknown;
    }

    syncInputsWithState(elements, state);
    applyResolution();
    requestHybridRefreshIfNeeded();
}

function installAutomationApi() {
    window.__maskitTest = {
        setParams,
        renderOnce: async () => {
            const wallStart = performance.now();
            if (isHybridRefineEnabled(state)) {
                await ensureHybridFrame(true);
            } else {
                await renderer.renderOnce(getRendererState(state));
            }
            return {
                ...getState(),
                wallRenderMs: performance.now() - wallStart,
            };
        },
        exportPpm: async () => buildCurrentFramePpm(),
        getPixelState: async (x, y) =>
            renderer.readPixelState(
                getRendererState(state),
                Math.max(0, Math.min(state.width - 1, Math.round(x))),
                Math.max(0, Math.min(state.height - 1, Math.round(y))),
            ),
        getClassificationStats: async () =>
            renderer.readClassificationStats(getRendererState(state)),
        getUnknownPixelIndices: async (limit = 256) =>
            renderer.readUnknownPixelIndices(
                getRendererState(state),
                Math.max(0, Math.round(limit)),
            ),
        getState,
        resetView: () => {
            state.offsetX = DEFAULT_VIEW.offsetX;
            state.offsetY = DEFAULT_VIEW.offsetY;
            state.scale = defaultScaleForResolution(state.width, state.height);
            syncInputsWithState(elements, state);
            requestHybridRefreshIfNeeded();
            setStatusMessage('view reset to match the BQ.py default window');
        },
    };
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
    requestHybridRefreshIfNeeded();
    setStatusMessage('WebGPU preview ready');
}

main().catch((error) => {
    console.error(error);
});
