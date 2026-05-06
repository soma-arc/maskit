import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from './viewer-state.js';

export function getViewerElements(doc = document) {
    return {
        canvas: doc.getElementById('c'),
        cpuRefineCanvas: doc.getElementById('cpu-refine-c'),
        modeSelect: doc.getElementById('mode'),
        solverSelect: doc.getElementById('solver'),
        yPlaneCanvas: doc.getElementById('y-plane'),
        yPlaneReadout: doc.getElementById('y-plane-readout'),
        yRealInput: doc.getElementById('y-real'),
        yImagInput: doc.getElementById('y-imag'),
        renderWidthInput: doc.getElementById('render-width'),
        renderHeightInput: doc.getElementById('render-height'),
        sinkItersInput: doc.getElementById('sink-iters'),
        dfsDepthInput: doc.getElementById('dfs-depth'),
        dfsVisitsInput: doc.getElementById('dfs-visits'),
        showCpuRefinePreviewInput: doc.getElementById('show-cpu-refine-preview'),
        applyResolutionButton: doc.getElementById('apply-resolution'),
        resetViewButton: doc.getElementById('reset-view'),
        exportPpmButton: doc.getElementById('export-ppm'),
        status: doc.getElementById('status'),
    };
}

export function syncInputsWithState(elements, state) {
    elements.modeSelect.value = String(state.mode);
    if (elements.solverSelect) {
        elements.solverSelect.value = String(state.solver);
    }
    elements.yRealInput.value = String(state.yReal);
    elements.yImagInput.value = String(state.yImag);
    if (elements.yPlaneReadout) {
        const imagSign = state.yImag >= 0 ? '+' : '-';
        elements.yPlaneReadout.textContent = `${state.yReal.toFixed(3)} ${imagSign} ${Math.abs(state.yImag).toFixed(3)}i`;
    }
    elements.renderWidthInput.value = String(state.width || DEFAULT_RENDER_WIDTH);
    elements.renderHeightInput.value = String(state.height || DEFAULT_RENDER_HEIGHT);
    elements.sinkItersInput.value = String(state.maxSinkIters);
    elements.dfsDepthInput.value = String(state.maxDfsDepth);
    elements.dfsVisitsInput.value = String(state.maxDfsVisits);
    if (elements.showCpuRefinePreviewInput) {
        elements.showCpuRefinePreviewInput.checked = Boolean(state.showCpuRefinePreview);
    }
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
    const cpuRefineTimingLines = state.cpuRefineTiming
        ? [
              `cpu refine overlay ms: unknown ${state.cpuRefineTiming.unknownReadbackMs.toFixed(2)}, worker ${state.cpuRefineTiming.workerRefineMs.toFixed(2)}, compose ${state.cpuRefineTiming.overlayComposeMs.toFixed(2)}`,
              `cpu refine export ms: readback ${state.cpuRefineTiming.exportReadbackMs.toFixed(2)}, compose ${state.cpuRefineTiming.exportComposeMs.toFixed(2)}`,
              state.cpuRefineTiming.classifyWaitMs != null
                  ? `cpu refine gpu ms: classify ${state.cpuRefineTiming.classifySubmitMs.toFixed(2)} + ${state.cpuRefineTiming.classifyWaitMs.toFixed(2)}, refine ${state.cpuRefineTiming.refineSubmitMs.toFixed(2)} + ${state.cpuRefineTiming.refineWaitMs.toFixed(2)}, finalize ${state.cpuRefineTiming.finalizeSubmitMs.toFixed(2)} + ${state.cpuRefineTiming.finalizeWaitMs.toFixed(2)}`
                  : '',
              state.cpuRefineTiming.statsMapMs != null
                  ? `cpu refine map ms: stats ${state.cpuRefineTiming.statsMapMs.toFixed(2)}, unknown ${state.cpuRefineTiming.unknownMapMs.toFixed(2)}`
                  : '',
          ]
        : [];

    return [
        `resolution: ${state.width} x ${state.height}`,
        `display: ${elementsLabelForMode(state.mode)}`,
        state.solver ? `calculation: ${elementsLabelForSolver(state.solver)}` : '',
        `offset: (${state.offsetX.toFixed(3)}, ${state.offsetY.toFixed(3)})`,
        `scale: ${state.scale.toFixed(3)} px/unit`,
        `y: ${state.yReal.toFixed(3)} + ${state.yImag.toFixed(3)}i`,
        `sink/dfs: ${state.maxSinkIters} / ${state.maxDfsDepth} / ${state.maxDfsVisits}`,
        state.solver === 'webgpu-cpu-refine'
            ? `cpu refine preview: ${state.showCpuRefinePreview ? 'on' : 'off'}`
            : '',
        `cpu: ${timing.lastCpuRenderMs.toFixed(2)} ms, gpu: ${timing.lastGpuRenderMs == null ? 'n/a' : `${timing.lastGpuRenderMs.toFixed(2)} ms`}, fps: ${fps.toFixed(1)}`,
        ...cpuRefineTimingLines,
        message,
    ]
        .filter(Boolean)
        .join('\n');
}

function elementsLabelForMode(mode) {
    switch (mode) {
        case 0:
            return 'Complex Plane Coordinates';
        case 1:
            return 'Markoff z Components';
        case 2:
            return 'Markoff |z|';
        case 3:
            return 'Quadratic Discriminant';
        case 4:
            return 'H(x) Branch Test';
        case 5:
            return 'BQ Binary Classification';
        default:
            return String(mode);
    }
}

function elementsLabelForSolver(solver) {
    switch (solver) {
        case 'webgpu-bounded':
            return 'WebGPU Bounded';
        case 'webgpu-cpu-refine':
            return 'WebGPU + CPU Refine';
        default:
            return String(solver);
    }
}
