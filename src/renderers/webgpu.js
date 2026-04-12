import SHADER_SOURCE from '../shaders/webgpu.wgsl?raw';

const UNIFORM_FLOAT_COUNT = 12;
const UNIFORM_BUFFER_SIZE = 64;

function assertWebgpu() {
    if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
    }
}

export async function createWebgpuRenderer({ canvas }) {
    assertWebgpu();

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('No WebGPU adapter available');
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) {
        throw new Error('Failed to create WebGPU canvas context');
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    const uniformBuffer = device.createBuffer({
        size: UNIFORM_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({ code: SHADER_SOURCE });
    const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    let configuredWidth = 0;
    let configuredHeight = 0;
    let lastCpuRenderMs = 0;
    const uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);

    function configure(width, height) {
        if (width === configuredWidth && height === configuredHeight) return;
        configuredWidth = width;
        configuredHeight = height;
        context.configure({
            device,
            format,
            alphaMode: 'opaque',
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST,
        });
    }

    function writeUniforms(state) {
        uniformData[0] = state.width;
        uniformData[1] = state.height;
        uniformData[2] = state.offsetX;
        uniformData[3] = state.offsetY;
        uniformData[4] = state.yReal;
        uniformData[5] = state.yImag;
        uniformData[6] = state.scale;
        uniformData[7] = state.mode;
        uniformData[8] = state.maxSinkIters;
        uniformData[9] = state.maxDfsDepth;
        uniformData[10] = state.maxDfsVisits;
        uniformData[11] = 0;
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    }

    function draw(textureView) {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });

        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();

        device.queue.submit([encoder.finish()]);
    }

    function render(state) {
        const cpuStart = performance.now();
        configure(state.width, state.height);
        writeUniforms(state);
        draw(context.getCurrentTexture().createView());
        lastCpuRenderMs = performance.now() - cpuStart;
    }

    async function renderOnce(state) {
        render(state);
        await device.queue.onSubmittedWorkDone();
    }

    async function readPixels(state) {
        configure(state.width, state.height);
        writeUniforms(state);

        const bytesPerPixel = 4;
        const unpaddedBytesPerRow = state.width * bytesPerPixel;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
        const outputBuffer = device.createBuffer({
            size: paddedBytesPerRow * state.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const texture = context.getCurrentTexture();
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: texture.createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();

        encoder.copyTextureToBuffer(
            { texture },
            { buffer: outputBuffer, bytesPerRow: paddedBytesPerRow },
            { width: state.width, height: state.height, depthOrArrayLayers: 1 },
        );

        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const mapped = outputBuffer.getMappedRange();
        const packed = new Uint8Array(state.width * state.height * bytesPerPixel);
        for (let row = 0; row < state.height; row += 1) {
            const sourceOffset = row * paddedBytesPerRow;
            const targetOffset = row * unpaddedBytesPerRow;
            packed.set(
                new Uint8Array(mapped.slice(sourceOffset, sourceOffset + unpaddedBytesPerRow)),
                targetOffset,
            );
        }

        outputBuffer.unmap();
        outputBuffer.destroy();
        return packed;
    }

    return {
        setViewport(width, height) {
            configure(width, height);
        },
        render,
        renderOnce,
        pollGpuTimer() {},
        waitForGpuTimer() {
            return Promise.resolve();
        },
        readPixels,
        getTiming() {
            return { lastCpuRenderMs, lastGpuRenderMs: null };
        },
    };
}
