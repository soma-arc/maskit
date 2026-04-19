import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from './viewer-state.js';

export function getViewerElements(doc = document) {
    return {
        canvas: doc.getElementById('c'),
        hybridCanvas: doc.getElementById('hybrid-c'),
        modeSelect: doc.getElementById('mode'),
        yRealInput: doc.getElementById('y-real'),
        yRealSliderInput: doc.getElementById('y-real-slider'),
        yImagInput: doc.getElementById('y-imag'),
        yImagSliderInput: doc.getElementById('y-imag-slider'),
        renderWidthInput: doc.getElementById('render-width'),
        renderHeightInput: doc.getElementById('render-height'),
        sinkItersInput: doc.getElementById('sink-iters'),
        dfsDepthInput: doc.getElementById('dfs-depth'),
        dfsVisitsInput: doc.getElementById('dfs-visits'),
        showGpuUnknownInput: doc.getElementById('show-gpu-unknown'),
        applyResolutionButton: doc.getElementById('apply-resolution'),
        resetViewButton: doc.getElementById('reset-view'),
        exportPpmButton: doc.getElementById('export-ppm'),
        status: doc.getElementById('status'),
    };
}

export function syncInputsWithState(elements, state) {
    elements.modeSelect.value = String(state.mode);
    elements.yRealInput.value = String(state.yReal);
    elements.yRealSliderInput.value = String(state.yReal);
    elements.yImagInput.value = String(state.yImag);
    elements.yImagSliderInput.value = String(state.yImag);
    elements.renderWidthInput.value = String(state.width || DEFAULT_RENDER_WIDTH);
    elements.renderHeightInput.value = String(state.height || DEFAULT_RENDER_HEIGHT);
    elements.sinkItersInput.value = String(state.maxSinkIters);
    elements.dfsDepthInput.value = String(state.maxDfsDepth);
    elements.dfsVisitsInput.value = String(state.maxDfsVisits);
    elements.showGpuUnknownInput.checked = Boolean(state.showGpuUnknown);
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
    const hybridTimingLines = state.hybridTiming
        ? [
              `hybrid overlay ms: unknown ${state.hybridTiming.unknownReadbackMs.toFixed(2)}, worker ${state.hybridTiming.workerRefineMs.toFixed(2)}, compose ${state.hybridTiming.overlayComposeMs.toFixed(2)}`,
              `hybrid export ms: readback ${state.hybridTiming.exportReadbackMs.toFixed(2)}, compose ${state.hybridTiming.exportComposeMs.toFixed(2)}`,
              state.hybridTiming.classifyWaitMs != null
                  ? `hybrid gpu ms: classify ${state.hybridTiming.classifySubmitMs.toFixed(2)} + ${state.hybridTiming.classifyWaitMs.toFixed(2)}, refine ${state.hybridTiming.refineSubmitMs.toFixed(2)} + ${state.hybridTiming.refineWaitMs.toFixed(2)}, finalize ${state.hybridTiming.finalizeSubmitMs.toFixed(2)} + ${state.hybridTiming.finalizeWaitMs.toFixed(2)}`
                  : '',
              state.hybridTiming.statsMapMs != null
                  ? `hybrid map ms: stats ${state.hybridTiming.statsMapMs.toFixed(2)}, unknown ${state.hybridTiming.unknownMapMs.toFixed(2)}`
                  : '',
          ]
        : [];

    return [
        `resolution: ${state.width} x ${state.height}`,
        `offset: (${state.offsetX.toFixed(3)}, ${state.offsetY.toFixed(3)})`,
        `scale: ${state.scale.toFixed(3)} px/unit`,
        `y: ${state.yReal.toFixed(3)} + ${state.yImag.toFixed(3)}i`,
        `sink/dfs: ${state.maxSinkIters} / ${state.maxDfsDepth} / ${state.maxDfsVisits}`,
        `show gpu unknown: ${state.showGpuUnknown ? 'on' : 'off'}`,
        `cpu: ${timing.lastCpuRenderMs.toFixed(2)} ms, gpu: ${timing.lastGpuRenderMs == null ? 'n/a' : `${timing.lastGpuRenderMs.toFixed(2)} ms`}, fps: ${fps.toFixed(1)}`,
        ...hybridTimingLines,
        message,
    ]
        .filter(Boolean)
        .join('\n');
}
