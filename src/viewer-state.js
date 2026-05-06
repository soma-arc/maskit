export const DEFAULT_VIEW = {
    offsetX: 1.975,
    offsetY: 6.025,
};

export const DEFAULT_RENDER_WIDTH = 640;
export const DEFAULT_RENDER_HEIGHT = 640;
export const DEFAULT_WORLD_SPAN = 16;
export const DEFAULT_WEBGPU_DISPLAY_MODE = 5;
export const DEFAULT_WEBGPU_SOLVER = 'webgpu-cpu-refine';

export function defaultScaleForResolution(width, height) {
    return Math.max(1, Math.min(width, height) / DEFAULT_WORLD_SPAN);
}

function parseFiniteParam(searchParams, name, fallback) {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function parseIntParam(searchParams, name, fallback) {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
}

function parseStringParam(searchParams, name, fallback) {
    const raw = searchParams.get(name);
    return raw == null || raw === '' ? fallback : raw;
}

function parseBooleanParam(searchParams, name, fallback) {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
}

export function createInitialViewerState(elements, searchParams) {
    const width = parseIntParam(
        searchParams,
        'width',
        Number.parseInt(elements.renderWidthInput.value, 10) || DEFAULT_RENDER_WIDTH,
    );
    const height = parseIntParam(
        searchParams,
        'height',
        Number.parseInt(elements.renderHeightInput.value, 10) || DEFAULT_RENDER_HEIGHT,
    );

    const mode = parseIntParam(
        searchParams,
        'mode',
        Number(elements.modeSelect?.value) || DEFAULT_WEBGPU_DISPLAY_MODE,
    );
    const solver = elements.solverSelect
        ? parseStringParam(searchParams, 'solver', elements.solverSelect.value || DEFAULT_WEBGPU_SOLVER)
        : null;
    const showCpuRefinePreview = parseBooleanParam(
        searchParams,
        'showCpuRefinePreview',
        elements.showCpuRefinePreviewInput?.checked ?? true,
    );

    return {
        width,
        height,
        offsetX: parseFiniteParam(searchParams, 'offsetX', DEFAULT_VIEW.offsetX),
        offsetY: parseFiniteParam(searchParams, 'offsetY', DEFAULT_VIEW.offsetY),
        scale: parseFiniteParam(searchParams, 'scale', defaultScaleForResolution(width, height)),
        yReal: parseFiniteParam(searchParams, 'yReal', Number(elements.yRealInput.value)),
        yImag: parseFiniteParam(searchParams, 'yImag', Number(elements.yImagInput.value)),
        mode,
        solver,
        showCpuRefinePreview,
        maxSinkIters: parseIntParam(
            searchParams,
            'sinkIters',
            Number(elements.sinkItersInput.value),
        ),
        maxDfsDepth: parseIntParam(searchParams, 'dfsDepth', Number(elements.dfsDepthInput.value)),
        maxDfsVisits: parseIntParam(
            searchParams,
            'dfsVisits',
            Number(elements.dfsVisitsInput.value),
        ),
    };
}
