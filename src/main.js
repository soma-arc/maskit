import VERT_SRC from './shaders/vert.glsl?raw';
import FRAG_SRC from './shaders/frag.glsl?raw';

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2');

if (!gl) {
    document.body.textContent = 'WebGL2 not supported';
    throw new Error('WebGL2 not supported');
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

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

// view state
let offsetX = 0.0; // complex-plane X (real)
let offsetY = 0.0; // complex-plane Y (imag)
let scale = 20.0; // pixels per unit  (matches BQ.py: 1/20 step)

// -- interaction --------------------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;

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
    offsetX -= (e.clientX - lastX) / scale;
    offsetY += (e.clientY - lastY) / scale;
    lastX = e.clientX;
    lastY = e.clientY;
});

canvas.addEventListener(
    'wheel',
    (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        scale *= factor;
    },
    { passive: false },
);

// -- render loop --------------------------------------------------------------

function frame() {
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform2f(uOffset, offsetX, offsetY);
    gl.uniform1f(uScale, scale);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
