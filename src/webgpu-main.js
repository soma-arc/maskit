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
const GPU_UNKNOWN_PREVIEW_MODE = 6;
const SOLVER_WEBGPU_CPU_REFINE = 'webgpu-cpu-refine';
const CPU_REFINE_SETTLE_DELAY_MS = 120;
const Y_PLANE_LIMIT = 8;
const Y_PLANE_GRID_STEP = 2;

const elements = getViewerElements();
const { canvas, cpuRefineCanvas } = elements;
const cpuRefineContext = cpuRefineCanvas.getContext('2d');
const yPlaneContext = elements.yPlaneCanvas?.getContext('2d');
const searchParams = new URLSearchParams(window.location.search);
const isAutomation = searchParams.get('automation') === '1';
const state = createInitialViewerState(elements, searchParams);
const cpuRefineWorker = new Worker(new URL('./workers/bq-refine-worker.js', import.meta.url), {
    type: 'module',
});

let renderer;
let fps = 0;
let statusMessage = '';
let cpuRefineRefreshPromise = null;
let cpuRefineRefreshPending = false;
let cpuRefineWorkerRequestId = 0;
let renderScheduled = false;
let lastRenderTimestamp = 0;
let cpuRefineSettleTimerId = null;
let draggingYPlane = false;

const cpuRefineWorkerRequests = new Map();

const cpuRefineFrame = {
    signature: null,
    exportPpm: null,
    refinement: null,
    unknownIndices: null,
    resolvedValues: null,
    timing: null,
};

cpuRefineWorker.addEventListener('message', (event) => {
    const {
        requestId,
        refinedMaskBuffer,
        resolvedValuesBuffer,
        resolvedCount,
        resolvedTrue,
        resolvedFalse,
        error,
    } = event.data;
    const pending = cpuRefineWorkerRequests.get(requestId);
    if (!pending) {
        return;
    }

    cpuRefineWorkerRequests.delete(requestId);

    if (error) {
        pending.reject(new Error(error));
        return;
    }

    pending.resolve({
        refinedMask: refinedMaskBuffer ? new Uint8Array(refinedMaskBuffer) : null,
        resolvedValues: resolvedValuesBuffer ? new Uint8Array(resolvedValuesBuffer) : null,
        resolvedCount,
        resolvedTrue,
        resolvedFalse,
    });
});

function getRendererState(viewState) {
    return viewState;
}

function isCpuRefineEnabled(viewState) {
    return viewState.solver === SOLVER_WEBGPU_CPU_REFINE && viewState.mode === GPU_COMPARE_MODE;
}

function getDisplayRendererState(viewState) {
    if (!isCpuRefineEnabled(viewState) || !viewState.showCpuRefinePreview) {
        return getRendererState(viewState);
    }

    return {
        ...getRendererState(viewState),
        mode: GPU_UNKNOWN_PREVIEW_MODE,
    };
}

function getExportRendererState(viewState) {
    return getRendererState(viewState);
}

function getCpuRefineSignature(viewState) {
    return JSON.stringify({
        width: viewState.width,
        height: viewState.height,
        offsetX: viewState.offsetX,
        offsetY: viewState.offsetY,
        scale: viewState.scale,
        yReal: viewState.yReal,
        yImag: viewState.yImag,
        solver: viewState.solver,
        maxSinkIters: viewState.maxSinkIters,
        maxDfsDepth: viewState.maxDfsDepth,
        maxDfsVisits: viewState.maxDfsVisits,
    });
}

function setStatusMessage(message = '') {
    statusMessage = message;
    updateStatus();
}

function clampYValue(value) {
    return Math.max(-Y_PLANE_LIMIT, Math.min(Y_PLANE_LIMIT, value));
}

function drawYPlane() {
    if (!yPlaneContext || !elements.yPlaneCanvas) {
        return;
    }

    const { width, height } = elements.yPlaneCanvas;
    const padding = 18;
    const axisWidth = width - padding * 2;
    const axisHeight = height - padding * 2;
    const scaleX = axisWidth / (Y_PLANE_LIMIT * 2);
    const scaleY = axisHeight / (Y_PLANE_LIMIT * 2);

    yPlaneContext.clearRect(0, 0, width, height);

    yPlaneContext.fillStyle = '#0c1620';
    yPlaneContext.fillRect(0, 0, width, height);

    yPlaneContext.strokeStyle = 'rgba(124, 197, 255, 0.12)';
    yPlaneContext.lineWidth = 1;
    for (let value = -Y_PLANE_LIMIT; value <= Y_PLANE_LIMIT; value += Y_PLANE_GRID_STEP) {
        const x = padding + (value + Y_PLANE_LIMIT) * scaleX;
        const y = padding + (Y_PLANE_LIMIT - value) * scaleY;
        yPlaneContext.beginPath();
        yPlaneContext.moveTo(x, padding);
        yPlaneContext.lineTo(x, height - padding);
        yPlaneContext.stroke();
        yPlaneContext.beginPath();
        yPlaneContext.moveTo(padding, y);
        yPlaneContext.lineTo(width - padding, y);
        yPlaneContext.stroke();
    }

    yPlaneContext.strokeStyle = 'rgba(124, 197, 255, 0.42)';
    yPlaneContext.lineWidth = 1.5;
    const originX = padding + Y_PLANE_LIMIT * scaleX;
    const originY = padding + Y_PLANE_LIMIT * scaleY;
    yPlaneContext.beginPath();
    yPlaneContext.moveTo(originX, padding);
    yPlaneContext.lineTo(originX, height - padding);
    yPlaneContext.stroke();
    yPlaneContext.beginPath();
    yPlaneContext.moveTo(padding, originY);
    yPlaneContext.lineTo(width - padding, originY);
    yPlaneContext.stroke();

    yPlaneContext.fillStyle = 'rgba(154, 177, 201, 0.85)';
    yPlaneContext.font = '11px "IBM Plex Sans", sans-serif';
    yPlaneContext.fillText('Im', 8, 14);
    yPlaneContext.fillText('Re', width - 26, height - 6);

    const pointX = padding + (clampYValue(state.yReal) + Y_PLANE_LIMIT) * scaleX;
    const pointY = padding + (Y_PLANE_LIMIT - clampYValue(state.yImag)) * scaleY;

    yPlaneContext.fillStyle = 'rgba(124, 197, 255, 0.18)';
    yPlaneContext.beginPath();
    yPlaneContext.arc(pointX, pointY, 11, 0, Math.PI * 2);
    yPlaneContext.fill();

    yPlaneContext.fillStyle = '#7cc5ff';
    yPlaneContext.beginPath();
    yPlaneContext.arc(pointX, pointY, 5, 0, Math.PI * 2);
    yPlaneContext.fill();

    yPlaneContext.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    yPlaneContext.lineWidth = 1;
    yPlaneContext.beginPath();
    yPlaneContext.arc(pointX, pointY, 5, 0, Math.PI * 2);
    yPlaneContext.stroke();
}

function updateYFromPlaneEvent(event) {
    if (!elements.yPlaneCanvas) {
        return;
    }
    const rect = elements.yPlaneCanvas.getBoundingClientRect();
    const width = elements.yPlaneCanvas.width;
    const height = elements.yPlaneCanvas.height;
    const padding = 18;
    const axisWidth = width - padding * 2;
    const axisHeight = height - padding * 2;
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const localY = ((event.clientY - rect.top) / rect.height) * height;
    const normalizedX = (localX - padding) / axisWidth;
    const normalizedY = (localY - padding) / axisHeight;
    state.yReal = clampYValue(normalizedX * (Y_PLANE_LIMIT * 2) - Y_PLANE_LIMIT);
    state.yImag = clampYValue(Y_PLANE_LIMIT - normalizedY * (Y_PLANE_LIMIT * 2));
    syncInputsWithState(elements, state);
    drawYPlane();
    requestCpuRefineRefreshIfNeeded({ deferCpuRefine: true });
    updateStatus();
}

function scheduleRender() {
    if (!renderer || isAutomation || renderScheduled) {
        return;
    }

    renderScheduled = true;
    requestAnimationFrame((now) => {
        renderScheduled = false;
        renderer.render(getDisplayRendererState(state));
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
    drawYPlane();
}

function hideCpuRefineCanvas() {
    cpuRefineCanvas.style.display = 'none';
    cpuRefineContext.clearRect(0, 0, cpuRefineCanvas.width, cpuRefineCanvas.height);
}

function invalidateCpuRefineFrame() {
    cpuRefineFrame.signature = null;
    cpuRefineFrame.exportPpm = null;
    cpuRefineFrame.refinement = null;
    cpuRefineFrame.unknownIndices = null;
    cpuRefineFrame.resolvedValues = null;
    cpuRefineFrame.timing = null;
}

function syncCpuRefineCanvasVisibility() {
    const shouldShow =
        isCpuRefineEnabled(state) &&
        state.showCpuRefinePreview &&
        cpuRefineFrame.signature === getCpuRefineSignature(state) &&
        cpuRefineFrame.refinement != null;

    cpuRefineCanvas.style.display = shouldShow ? 'block' : 'none';
    if (!shouldShow) {
        hideCpuRefineCanvas();
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

function applyResolvedUnknownValuesToMask(
    width,
    height,
    candidateMask,
    unknownIndices,
    resolvedValues,
) {
    const refinedMask = new Uint8Array(candidateMask);
    for (let index = 0; index < unknownIndices.length; index += 1) {
        const rowMajorIndex = unknownIndices[index];
        const x = rowMajorIndex % width;
        const y = Math.floor(rowMajorIndex / width);
        const maskIndex = (height - 1 - y) * width + x;
        refinedMask[maskIndex] = resolvedValues[index];
    }
    return refinedMask;
}

function runCpuRefineWorkerJob(payload, transferList = []) {
    const requestId = cpuRefineWorkerRequestId;
    cpuRefineWorkerRequestId += 1;

    return new Promise((resolve, reject) => {
        cpuRefineWorkerRequests.set(requestId, { resolve, reject });
        cpuRefineWorker.postMessage({ requestId, ...payload }, transferList);
    });
}

function resolveUnknownPixelsInWorker(renderState, unknownIndices, options) {
    return runCpuRefineWorkerJob({
        action: 'resolveUnknownPixels',
        renderState,
        unknownIndicesBuffer: unknownIndices.buffer,
        options,
    });
}

function drawCpuRefineFrame(width, height, pixels) {
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    cpuRefineContext.putImageData(imageData, 0, 0);
    cpuRefineCanvas.style.display = 'block';
}

function buildUnknownOverlayFromResolvedValues(width, height, resolvedValues, unknownIndices) {
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < unknownIndices.length; index += 1) {
        const channel = resolvedValues[index] === 1 ? 0 : 255;
        const rowMajorIndex = unknownIndices[index];
        const x = rowMajorIndex % width;
        const y = Math.floor(rowMajorIndex / width);
        const rgbaIndex = (y * width + x) * 4;
        pixels[rgbaIndex] = channel;
        pixels[rgbaIndex + 1] = channel;
        pixels[rgbaIndex + 2] = channel;
        pixels[rgbaIndex + 3] = 255;
    }
    return pixels;
}

async function buildCpuRefineOverlayFrame(viewState) {
    const renderState = getRendererState(viewState);
    const unknownPayload = isAutomation
        ? await renderer.measureHybridUnknownPass(renderState, {
              presentToCanvas: false,
          })
        : await renderer.readUnknownPixelIndexBufferSinglePass(getDisplayRendererState(viewState), {
              presentToCanvas: true,
          });
    const unknownReadbackMs =
        (unknownPayload.timing?.classifySubmitMs ?? 0) +
        (unknownPayload.timing?.classifyWaitMs ?? 0) +
        (unknownPayload.timing?.refineSubmitMs ?? 0) +
        (unknownPayload.timing?.refineWaitMs ?? 0) +
        (unknownPayload.timing?.finalizeSubmitMs ?? 0) +
        (unknownPayload.timing?.finalizeWaitMs ?? 0) +
        (unknownPayload.timing?.statsMapMs ?? 0) +
        (unknownPayload.timing?.unknownMapMs ?? 0);

    const workerRefineStart = performance.now();
    const refined = await resolveUnknownPixelsInWorker(renderState, unknownPayload.indices, {
        maxSinkIters: 1_000_000,
        maxDepth: 995,
    });
    const workerRefineMs = performance.now() - workerRefineStart;

    const overlayComposeStart = performance.now();
    const cpuRefinePixels = buildUnknownOverlayFromResolvedValues(
        renderState.width,
        renderState.height,
        refined.resolvedValues,
        unknownPayload.indices,
    );
    const overlayComposeMs = performance.now() - overlayComposeStart;

    return {
        signature: getCpuRefineSignature(viewState),
        pixels: cpuRefinePixels,
        refinement: {
            unknownCount: unknownPayload.unknownCount,
            refinedPixelCount: refined.resolvedCount,
            resolvedTrue: refined.resolvedTrue,
            resolvedFalse: refined.resolvedFalse,
        },
        unknownIndices: unknownPayload.indices,
        resolvedValues: refined.resolvedValues,
        timing: {
            unknownReadbackMs,
            workerRefineMs,
            overlayComposeMs,
            exportReadbackMs: 0,
            exportComposeMs: 0,
            classifySubmitMs: unknownPayload.timing?.classifySubmitMs ?? 0,
            classifyWaitMs: unknownPayload.timing?.classifyWaitMs ?? 0,
            refineSubmitMs: unknownPayload.timing?.refineSubmitMs ?? 0,
            refineWaitMs: unknownPayload.timing?.refineWaitMs ?? 0,
            finalizeSubmitMs: unknownPayload.timing?.finalizeSubmitMs ?? 0,
            finalizeWaitMs: unknownPayload.timing?.finalizeWaitMs ?? 0,
            statsMapMs: unknownPayload.timing?.statsMapMs ?? 0,
            unknownMapMs: unknownPayload.timing?.unknownMapMs ?? 0,
        },
    };
}

async function buildCpuRefineExportPpm(viewState) {
    const renderState = getExportRendererState(viewState);
    const exportReadbackStart = performance.now();
    const pixels = await renderer.readPixels(renderState);
    const exportReadbackMs = performance.now() - exportReadbackStart;

    const exportComposeStart = performance.now();
    const candidateMask = buildBinaryMaskFromRgba(renderState.width, renderState.height, pixels);

    const signature = getCpuRefineSignature(viewState);
    let unknownIndices = cpuRefineFrame.unknownIndices;
    let resolvedValues = cpuRefineFrame.resolvedValues;
    if (cpuRefineFrame.signature !== signature || !unknownIndices || !resolvedValues) {
        const overlayFrame = await buildCpuRefineOverlayFrame(viewState);
        unknownIndices = overlayFrame.unknownIndices;
        resolvedValues = overlayFrame.resolvedValues;
        cpuRefineFrame.signature = overlayFrame.signature;
        cpuRefineFrame.refinement = overlayFrame.refinement;
        cpuRefineFrame.unknownIndices = overlayFrame.unknownIndices;
        cpuRefineFrame.resolvedValues = overlayFrame.resolvedValues;
        drawCpuRefineFrame(state.width, state.height, overlayFrame.pixels);
        syncCpuRefineCanvasVisibility();
    }

    const refinedMask = applyResolvedUnknownValuesToMask(
        renderState.width,
        renderState.height,
        candidateMask,
        unknownIndices,
        resolvedValues,
    );
    const ppm = buildPpmFromBinaryMask(renderState.width, renderState.height, refinedMask);
    const exportComposeMs = performance.now() - exportComposeStart;

    cpuRefineFrame.timing = {
        unknownReadbackMs: cpuRefineFrame.timing?.unknownReadbackMs ?? 0,
        workerRefineMs: cpuRefineFrame.timing?.workerRefineMs ?? 0,
        overlayComposeMs: cpuRefineFrame.timing?.overlayComposeMs ?? 0,
        exportReadbackMs,
        exportComposeMs,
    };

    return ppm;
}

async function ensureCpuRefineFrame(force = false) {
    if (!isCpuRefineEnabled(state)) {
        syncCpuRefineCanvasVisibility();
        return null;
    }

    const signature = getCpuRefineSignature(state);
    if (!force && cpuRefineFrame.signature === signature && cpuRefineFrame.refinement != null) {
        syncCpuRefineCanvasVisibility();
        return cpuRefineFrame;
    }

    const nextFrame = await buildCpuRefineOverlayFrame(state);
    cpuRefineFrame.signature = nextFrame.signature;
    cpuRefineFrame.exportPpm = null;
    cpuRefineFrame.refinement = nextFrame.refinement;
    cpuRefineFrame.unknownIndices = nextFrame.unknownIndices;
    cpuRefineFrame.resolvedValues = nextFrame.resolvedValues;
    cpuRefineFrame.timing = nextFrame.timing;
    drawCpuRefineFrame(state.width, state.height, nextFrame.pixels);
    if (!isAutomation) {
        const now = performance.now();
        if (lastRenderTimestamp > 0) {
            const deltaMs = now - lastRenderTimestamp;
            fps = deltaMs > 0 ? 1000 / deltaMs : 0;
        }
        lastRenderTimestamp = now;
    }
    syncCpuRefineCanvasVisibility();
    setStatusMessage(
        `cpu refine: refined ${nextFrame.refinement.refinedPixelCount} unresolved pixels (${nextFrame.refinement.resolvedTrue} -> true, ${nextFrame.refinement.resolvedFalse} -> false)`,
    );
    return cpuRefineFrame;
}

async function flushCpuRefineRefreshQueue() {
    while (cpuRefineRefreshPending) {
        cpuRefineRefreshPending = false;
        try {
            await ensureCpuRefineFrame(true);
        } catch (error) {
            hideCpuRefineCanvas();
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`cpu refine error: ${message}`);
        }
    }
    cpuRefineRefreshPromise = null;
}

function requestCpuRefineRefresh() {
    cpuRefineRefreshPending = true;
    syncCpuRefineCanvasVisibility();
    if (!cpuRefineRefreshPromise) {
        setStatusMessage('cpu refine: refining unresolved pixels in browser');
        cpuRefineRefreshPromise = flushCpuRefineRefreshQueue();
    }
}

function clearCpuRefineSettleTimer() {
    if (cpuRefineSettleTimerId != null) {
        window.clearTimeout(cpuRefineSettleTimerId);
        cpuRefineSettleTimerId = null;
    }
}

function scheduleCpuRefineRefreshAfterDelay() {
    clearCpuRefineSettleTimer();
    cpuRefineSettleTimerId = window.setTimeout(() => {
        cpuRefineSettleTimerId = null;
        if (isCpuRefineEnabled(state)) {
            requestCpuRefineRefresh();
        }
    }, CPU_REFINE_SETTLE_DELAY_MS);
}

function applyResolution() {
    syncInputsWithState(elements, state);
    applyCanvasResolution(canvas, state.width, state.height);
    applyCanvasResolution(cpuRefineCanvas, state.width, state.height);
    renderer.setViewport(state.width, state.height);
    cpuRefineFrame.signature = null;
    cpuRefineFrame.exportPpm = null;
    cpuRefineFrame.refinement = null;
    cpuRefineFrame.unknownIndices = null;
    cpuRefineFrame.resolvedValues = null;
    cpuRefineFrame.timing = null;
    syncCpuRefineCanvasVisibility();
    setStatusMessage('canvas display size matches the render buffer');
}

function requestCpuRefineRefreshIfNeeded({ deferCpuRefine = false } = {}) {
    if (isCpuRefineEnabled(state)) {
        invalidateCpuRefineFrame();
        hideCpuRefineCanvas();
        scheduleRender();
        if (deferCpuRefine) {
            scheduleCpuRefineRefreshAfterDelay();
        } else {
            clearCpuRefineSettleTimer();
            requestCpuRefineRefresh();
        }
    } else {
        clearCpuRefineSettleTimer();
        scheduleRender();
        syncCpuRefineCanvasVisibility();
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
    const wasDragging = dragging;
    const wasDraggingYPlane = draggingYPlane;
    dragging = false;
    draggingYPlane = false;
    if ((wasDragging || wasDraggingYPlane) && isCpuRefineEnabled(state)) {
        clearCpuRefineSettleTimer();
        requestCpuRefineRefresh();
    }
});

window.addEventListener('mousemove', (event) => {
    if (draggingYPlane) {
        updateYFromPlaneEvent(event);
        return;
    }
    if (!dragging) return;
    const { dx, dy } = cssDeltaToBufferDelta(event.clientX - lastX, event.clientY - lastY);
    state.offsetX -= dx / state.scale;
    state.offsetY -= dy / state.scale;
    lastX = event.clientX;
    lastY = event.clientY;
    requestCpuRefineRefreshIfNeeded({ deferCpuRefine: true });
    updateStatus();
});

canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        state.scale *= factor;
        requestCpuRefineRefreshIfNeeded({ deferCpuRefine: true });
        updateStatus();
    },
    { passive: false },
);

elements.applyResolutionButton.addEventListener('click', () => {
    sanitizeResolutionFromInputs(elements, state);
    applyResolution();
    requestCpuRefineRefreshIfNeeded();
});

elements.resetViewButton.addEventListener('click', () => {
    state.offsetX = DEFAULT_VIEW.offsetX;
    state.offsetY = DEFAULT_VIEW.offsetY;
    state.scale = defaultScaleForResolution(state.width, state.height);
    requestCpuRefineRefreshIfNeeded();
    setStatusMessage('view reset to match the BQ.py default window');
});

elements.modeSelect.addEventListener('change', () => {
    state.mode = Number(elements.modeSelect.value);
    syncInputsWithState(elements, state);
    requestCpuRefineRefreshIfNeeded();
    updateStatus();
});

if (elements.solverSelect) {
    elements.solverSelect.addEventListener('change', () => {
        state.solver = elements.solverSelect.value;
        syncInputsWithState(elements, state);
        requestCpuRefineRefreshIfNeeded();
        updateStatus();
    });
}

if (elements.showCpuRefinePreviewInput) {
    elements.showCpuRefinePreviewInput.addEventListener('change', () => {
        state.showCpuRefinePreview = elements.showCpuRefinePreviewInput.checked;
        syncInputsWithState(elements, state);
        syncCpuRefineCanvasVisibility();
        updateStatus();
    });
}

function updateYFromInputs(nextReal, nextImag) {
    state.yReal = clampYValue(Number(nextReal));
    state.yImag = clampYValue(Number(nextImag));
    syncInputsWithState(elements, state);
    requestCpuRefineRefreshIfNeeded();
    updateStatus();
}

elements.yRealInput.addEventListener('input', () => {
    updateYFromInputs(elements.yRealInput.value, elements.yImagInput.value);
});

elements.yImagInput.addEventListener('input', () => {
    updateYFromInputs(elements.yRealInput.value, elements.yImagInput.value);
});

if (elements.yPlaneCanvas) {
    elements.yPlaneCanvas.addEventListener('mousedown', (event) => {
        draggingYPlane = true;
        updateYFromPlaneEvent(event);
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
        requestCpuRefineRefreshIfNeeded();
        updateStatus();
    });
}

async function buildCurrentFramePpm() {
    if (isCpuRefineEnabled(state)) {
        await ensureCpuRefineFrame();
        if (cpuRefineFrame.exportPpm == null) {
            cpuRefineFrame.exportPpm = await buildCpuRefineExportPpm(state);
        }
        return cpuRefineFrame.exportPpm;
    }

    const pixels = await renderer.readPixels(getExportRendererState(state));
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
        cpuRefine: cpuRefineFrame.refinement,
        cpuRefineTiming: cpuRefineFrame.timing,
    };
}

function setParams(params = {}) {
    if (typeof params.yReal === 'number') state.yReal = params.yReal;
    if (typeof params.yImag === 'number') state.yImag = params.yImag;
    if (typeof params.mode === 'number') state.mode = params.mode;
    if (typeof params.solver === 'string') state.solver = params.solver;
    if (typeof params.showCpuRefinePreview === 'boolean') {
        state.showCpuRefinePreview = params.showCpuRefinePreview;
    }
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
    requestCpuRefineRefreshIfNeeded();
}

function installAutomationApi() {
    window.__maskitTest = {
        setParams,
        renderOnce: async () => {
            const wallStart = performance.now();
            if (isCpuRefineEnabled(state)) {
                await ensureCpuRefineFrame(true);
            } else {
                await renderer.renderOnce(getExportRendererState(state));
            }
            return {
                ...getState(),
                wallRenderMs: performance.now() - wallStart,
            };
        },
        exportPpm: async () => buildCurrentFramePpm(),
        getPixelState: async (x, y) =>
            renderer.readPixelState(
                getExportRendererState(state),
                Math.max(0, Math.min(state.width - 1, Math.round(x))),
                Math.max(0, Math.min(state.height - 1, Math.round(y))),
            ),
        getClassificationStats: async () =>
            renderer.readClassificationStats(getExportRendererState(state)),
        getUnknownPixelIndices: async (limit = 256) =>
            renderer.readUnknownPixelIndices(
                getExportRendererState(state),
                Math.max(0, Math.round(limit)),
            ),
        getState,
        resetView: () => {
            state.offsetX = DEFAULT_VIEW.offsetX;
            state.offsetY = DEFAULT_VIEW.offsetY;
            state.scale = defaultScaleForResolution(state.width, state.height);
            syncInputsWithState(elements, state);
            requestCpuRefineRefreshIfNeeded();
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
    requestCpuRefineRefreshIfNeeded();
    setStatusMessage('WebGPU preview ready');
}

main().catch((error) => {
    console.error(error);
});
