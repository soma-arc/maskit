import SHADER_SOURCE from '../shaders/webgpu.wgsl?raw';

const UNIFORM_FLOAT_COUNT = 12;
const UNIFORM_BUFFER_SIZE = 64;
const WORKGROUP_SIZE = 8;
const OUTPUT_TEXTURE_FORMAT = 'rgba8unorm';
const PIXEL_STATE_FLOAT_COUNT = 8;
const PIXEL_STATE_STRIDE = PIXEL_STATE_FLOAT_COUNT * Float32Array.BYTES_PER_ELEMENT;
const CLASSIFICATION_STATS_UINT_COUNT = 4;
const CLASSIFICATION_STATS_BUFFER_SIZE =
    CLASSIFICATION_STATS_UINT_COUNT * Uint32Array.BYTES_PER_ELEMENT;
const EMPTY_CLASSIFICATION_STATS = new Uint32Array(CLASSIFICATION_STATS_UINT_COUNT);
const UNKNOWN_INDEX_STRIDE = Uint32Array.BYTES_PER_ELEMENT;

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
    let pixelStateBuffer = null;
    let classificationStatsBuffer = null;
    let unknownIndexBuffer = null;
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
        if (pixelStateBuffer) {
            pixelStateBuffer.destroy();
        }
        if (classificationStatsBuffer) {
            classificationStatsBuffer.destroy();
        }
        if (unknownIndexBuffer) {
            unknownIndexBuffer.destroy();
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
        pixelStateBuffer = device.createBuffer({
            size: width * height * PIXEL_STATE_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        classificationStatsBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        unknownIndexBuffer = device.createBuffer({
            size: width * height * UNKNOWN_INDEX_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        computeBindGroup = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: outputTextureView },
                { binding: 2, resource: { buffer: pixelStateBuffer } },
                { binding: 3, resource: { buffer: classificationStatsBuffer } },
                { binding: 4, resource: { buffer: unknownIndexBuffer } },
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
        device.queue.writeBuffer(classificationStatsBuffer, 0, EMPTY_CLASSIFICATION_STATS);

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

    async function readPixelState(state, x, y) {
        ensureConfigured(state.width, state.height);
        if (x < 0 || x >= state.width || y < 0 || y >= state.height) {
            throw new Error(`Pixel coordinates out of range: (${x}, ${y})`);
        }

        const rowMajorIndex = y * state.width + x;
        const offset = rowMajorIndex * PIXEL_STATE_STRIDE;
        const outputBuffer = device.createBuffer({
            size: PIXEL_STATE_STRIDE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        writeUniforms(state);
        device.queue.writeBuffer(classificationStatsBuffer, 0, EMPTY_CLASSIFICATION_STATS);
        const encoder = device.createCommandEncoder();
        encodeComputePass(encoder, state);
        encoder.copyBufferToBuffer(pixelStateBuffer, offset, outputBuffer, 0, PIXEL_STATE_STRIDE);
        device.queue.submit([encoder.finish()]);

        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const mapped = outputBuffer.getMappedRange();
        const values = new Float32Array(mapped.slice(0));
        outputBuffer.unmap();
        outputBuffer.destroy();

        const statusCode = Math.round(values[6]);
        const statusName = statusCode === 1 ? 'true' : statusCode === 2 ? 'unknown' : 'false';

        return {
            x: { real: values[0], imag: values[1] },
            y: { real: values[2], imag: values[3] },
            z: { real: values[4], imag: values[5] },
            statusCode,
            statusName,
            isBqLike: statusCode === 1,
            reserved: values[7],
        };
    }

    async function readClassificationStats(state) {
        ensureConfigured(state.width, state.height);

        const outputBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        writeUniforms(state);
        device.queue.writeBuffer(classificationStatsBuffer, 0, EMPTY_CLASSIFICATION_STATS);

        const encoder = device.createCommandEncoder();
        encodeComputePass(encoder, state);
        encoder.copyBufferToBuffer(
            classificationStatsBuffer,
            0,
            outputBuffer,
            0,
            CLASSIFICATION_STATS_BUFFER_SIZE,
        );
        device.queue.submit([encoder.finish()]);

        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const values = new Uint32Array(outputBuffer.getMappedRange().slice(0));
        outputBuffer.unmap();
        outputBuffer.destroy();

        return {
            falseCount: values[0],
            trueCount: values[1],
            unknownCount: values[2],
            totalCount: values[0] + values[1] + values[2],
        };
    }

    async function readUnknownPixelIndices(state, limit = 256) {
        ensureConfigured(state.width, state.height);

        const statsReadBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const unknownReadBuffer = device.createBuffer({
            size: state.width * state.height * UNKNOWN_INDEX_STRIDE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        writeUniforms(state);
        device.queue.writeBuffer(classificationStatsBuffer, 0, EMPTY_CLASSIFICATION_STATS);

        const encoder = device.createCommandEncoder();
        encodeComputePass(encoder, state);
        encoder.copyBufferToBuffer(
            classificationStatsBuffer,
            0,
            statsReadBuffer,
            0,
            CLASSIFICATION_STATS_BUFFER_SIZE,
        );
        encoder.copyBufferToBuffer(
            unknownIndexBuffer,
            0,
            unknownReadBuffer,
            0,
            state.width * state.height * UNKNOWN_INDEX_STRIDE,
        );
        device.queue.submit([encoder.finish()]);

        await device.queue.onSubmittedWorkDone();
        await Promise.all([
            statsReadBuffer.mapAsync(GPUMapMode.READ),
            unknownReadBuffer.mapAsync(GPUMapMode.READ),
        ]);

        const statsValues = new Uint32Array(statsReadBuffer.getMappedRange().slice(0));
        const unknownCount = statsValues[2];
        const rawIndices = new Uint32Array(unknownReadBuffer.getMappedRange().slice(0));
        const clampedLimit = Math.max(0, Math.min(limit, unknownCount));
        const indices = Array.from(rawIndices.subarray(0, clampedLimit)).map((index) => ({
            index,
            x: index % state.width,
            y: Math.floor(index / state.width),
        }));

        statsReadBuffer.unmap();
        statsReadBuffer.destroy();
        unknownReadBuffer.unmap();
        unknownReadBuffer.destroy();

        return {
            unknownCount,
            returnedCount: indices.length,
            truncated: clampedLimit < unknownCount,
            indices,
        };
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
        readPixelState,
        readClassificationStats,
        readUnknownPixelIndices,
        getTiming() {
            return { lastCpuRenderMs, lastGpuRenderMs: null };
        },
    };
}
