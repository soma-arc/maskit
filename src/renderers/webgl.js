function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
    }
    return shader;
}

function linkProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Program link failed');
    }
    return program;
}

export function createWebglRenderer({ canvas, vertexSource, fragmentSource }) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) {
        throw new Error('WebGL2 not supported');
    }

    const program = linkProgram(
        gl,
        compileShader(gl, gl.VERTEX_SHADER, vertexSource),
        compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource),
    );
    gl.useProgram(program);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
    );

    const positionLocation = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uniformLocations = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        offset: gl.getUniformLocation(program, 'u_offset'),
        scale: gl.getUniformLocation(program, 'u_scale'),
        y: gl.getUniformLocation(program, 'u_y'),
        mode: gl.getUniformLocation(program, 'u_mode'),
        maxSinkIters: gl.getUniformLocation(program, 'u_max_sink_iters'),
        maxDfsDepth: gl.getUniformLocation(program, 'u_max_dfs_depth'),
        maxDfsVisits: gl.getUniformLocation(program, 'u_max_dfs_visits'),
    };

    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let pendingTimerQuery = null;
    let lastCpuRenderMs = 0;
    let lastGpuRenderMs = null;

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

    function render(state) {
        const cpuStart = performance.now();
        beginGpuTimer();
        gl.uniform2f(uniformLocations.resolution, state.width, state.height);
        gl.uniform2f(uniformLocations.offset, state.offsetX, state.offsetY);
        gl.uniform1f(uniformLocations.scale, state.scale);
        gl.uniform2f(uniformLocations.y, state.yReal, state.yImag);
        gl.uniform1i(uniformLocations.mode, state.mode);
        gl.uniform1i(uniformLocations.maxSinkIters, state.maxSinkIters);
        gl.uniform1i(uniformLocations.maxDfsDepth, state.maxDfsDepth);
        gl.uniform1i(uniformLocations.maxDfsVisits, state.maxDfsVisits);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        endGpuTimer();
        lastCpuRenderMs = performance.now() - cpuStart;
    }

    function renderOnce(state) {
        render(state);
        gl.finish();
    }

    function readPixels(width, height) {
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
    }

    return {
        setViewport(width, height) {
            gl.viewport(0, 0, width, height);
        },
        render,
        renderOnce,
        pollGpuTimer,
        waitForGpuTimer,
        readPixels,
        getTiming() {
            return { lastCpuRenderMs, lastGpuRenderMs };
        },
    };
}
