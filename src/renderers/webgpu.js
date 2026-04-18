import SHADER_SOURCE from '../shaders/webgpu.wgsl?raw';

const UNIFORM_FLOAT_COUNT = 12;
const UNIFORM_BUFFER_SIZE = 64;
const WORKGROUP_SIZE = 8;
const OUTPUT_TEXTURE_FORMAT = 'rgba8unorm';

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

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    const uniformBuffer = device.createBuffer({
        size: UNIFORM_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    const shaderModule = device.createShaderModule({ code: SHADER_SOURCE });
    const computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'cs_main',
        },
    });
    const blitPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: 'blit_vs_main',
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'blit_fs_main',
            targets: [{ format: presentationFormat }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });

    const uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
    let configuredWidth = 0;
    let configuredHeight = 0;
    let outputTexture = null;
    let outputTextureView = null;
    let computeBindGroup = null;
    let blitBindGroup = null;
    let lastCpuRenderMs = 0;

    function configureContext(width, height) {
        context.configure({
            device,
            format: presentationFormat,
            alphaMode: 'opaque',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        configuredWidth = width;
        configuredHeight = height;
    }

    function recreateOutputResources(width, height) {
        if (outputTexture) {
            outputTexture.destroy();
        }

        outputTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: OUTPUT_TEXTURE_FORMAT,
            usage:
                GPUTextureUsage.STORAGE_BINDING |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC,
        });
        outputTextureView = outputTexture.createView();

        computeBindGroup = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: outputTextureView },
            ],
        });

        blitBindGroup = device.createBindGroup({
            layout: blitPipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: sampler },
                { binding: 1, resource: outputTextureView },
            ],
        });
    }

    function ensureConfigured(width, height) {
        if (width === configuredWidth && height === configuredHeight && outputTexture) return;
        configureContext(width, height);
        recreateOutputResources(width, height);
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

    function encodeComputePass(encoder, state) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, computeBindGroup);
        computePass.dispatchWorkgroups(
            Math.ceil(state.width / WORKGROUP_SIZE),
            Math.ceil(state.height / WORKGROUP_SIZE),
        );
        computePass.end();
    }

    function encodeBlitPass(encoder, targetView) {
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: targetView,
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        renderPass.setPipeline(blitPipeline);
        renderPass.setBindGroup(1, blitBindGroup);
        renderPass.draw(3);
        renderPass.end();
    }

    function submitRender(state, { presentToCanvas = true, copyBuffer = null } = {}) {
        ensureConfigured(state.width, state.height);
        writeUniforms(state);

        const encoder = device.createCommandEncoder();
        encodeComputePass(encoder, state);

        if (presentToCanvas) {
            encodeBlitPass(encoder, context.getCurrentTexture().createView());
        }

        if (copyBuffer) {
            encoder.copyTextureToBuffer(
                { texture: outputTexture },
                { buffer: copyBuffer.buffer, bytesPerRow: copyBuffer.bytesPerRow },
                {
                    width: state.width,
                    height: state.height,
                    depthOrArrayLayers: 1,
                },
            );
        }

        device.queue.submit([encoder.finish()]);
    }

    function render(state) {
        const cpuStart = performance.now();
        submitRender(state, { presentToCanvas: true });
        lastCpuRenderMs = performance.now() - cpuStart;
    }

    async function renderOnce(state) {
        render(state);
        await device.queue.onSubmittedWorkDone();
    }

    async function readPixels(state) {
        const bytesPerPixel = 4;
        const unpaddedBytesPerRow = state.width * bytesPerPixel;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
        const outputBuffer = device.createBuffer({
            size: paddedBytesPerRow * state.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        submitRender(state, {
            presentToCanvas: false,
            copyBuffer: {
                buffer: outputBuffer,
                bytesPerRow: paddedBytesPerRow,
            },
        });

        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const mapped = outputBuffer.getMappedRange();
        const packed = new Uint8Array(state.width * state.height * bytesPerPixel);
        const source = new Uint8Array(mapped);
        for (let row = 0; row < state.height; row += 1) {
            const sourceOffset = row * paddedBytesPerRow;
            const targetOffset = row * unpaddedBytesPerRow;
            packed.set(
                source.subarray(sourceOffset, sourceOffset + unpaddedBytesPerRow),
                targetOffset,
            );
        }

        outputBuffer.unmap();
        outputBuffer.destroy();
        return packed;
    }

    return {
        setViewport(width, height) {
            ensureConfigured(width, height);
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
