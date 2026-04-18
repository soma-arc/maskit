import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from './viewer-state.js';

export function getViewerElements(doc = document) {
    return {
        canvas: doc.getElementById('c'),
        hybridCanvas: doc.getElementById('hybrid-c'),
        modeSelect: doc.getElementById('mode'),
        yRealInput: doc.getElementById('y-real'),
        yImagInput: doc.getElementById('y-imag'),
        renderWidthInput: doc.getElementById('render-width'),
        renderHeightInput: doc.getElementById('render-height'),
        sinkItersInput: doc.getElementById('sink-iters'),
        dfsDepthInput: doc.getElementById('dfs-depth'),
        dfsVisitsInput: doc.getElementById('dfs-visits'),
        applyResolutionButton: doc.getElementById('apply-resolution'),
        resetViewButton: doc.getElementById('reset-view'),
        exportPpmButton: doc.getElementById('export-ppm'),
        status: doc.getElementById('status'),
    };
}

export function syncInputsWithState(elements, state) {
    elements.modeSelect.value = String(state.mode);
    elements.yRealInput.value = String(state.yReal);
    elements.yImagInput.value = String(state.yImag);
    elements.renderWidthInput.value = String(state.width || DEFAULT_RENDER_WIDTH);
    elements.renderHeightInput.value = String(state.height || DEFAULT_RENDER_HEIGHT);
    elements.sinkItersInput.value = String(state.maxSinkIters);
    elements.dfsDepthInput.value = String(state.maxDfsDepth);
    elements.dfsVisitsInput.value = String(state.maxDfsVisits);
}

export function sanitizeResolutionFromInputs(elements, state) {
    state.width = Math.max(
        1,
        Number.parseInt(elements.renderWidthInput.value, 10) || DEFAULT_RENDER_WIDTH,
    );
    state.height = Math.max(
        1,
        Number.parseInt(elements.renderHeightInput.value, 10) || DEFAULT_RENDER_HEIGHT,
    );
}

export function applyCanvasResolution(canvas, width, height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
}

export function buildStatusText({ state, timing, fps, message = '' }) {
    return [
        `resolution: ${state.width} x ${state.height}`,
        `offset: (${state.offsetX.toFixed(3)}, ${state.offsetY.toFixed(3)})`,
        `scale: ${state.scale.toFixed(3)} px/unit`,
        `y: ${state.yReal.toFixed(3)} + ${state.yImag.toFixed(3)}i`,
        `sink/dfs: ${state.maxSinkIters} / ${state.maxDfsDepth} / ${state.maxDfsVisits}`,
        `cpu: ${timing.lastCpuRenderMs.toFixed(2)} ms, gpu: ${timing.lastGpuRenderMs == null ? 'n/a' : `${timing.lastGpuRenderMs.toFixed(2)} ms`}, fps: ${fps.toFixed(1)}`,
        message,
    ]
        .filter(Boolean)
        .join('\n');
}
