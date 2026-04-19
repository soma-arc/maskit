import SHADER_SOURCE from '../shaders/webgpu.wgsl?raw';

const UNIFORM_FLOAT_COUNT = 12;
const UNIFORM_BUFFER_SIZE = 64;
const WORKGROUP_SIZE = 8;
const OUTPUT_TEXTURE_FORMAT = 'rgba8unorm';
const PIXEL_STATE_FLOAT_COUNT = 8;
const PIXEL_STATE_STRIDE = PIXEL_STATE_FLOAT_COUNT * Float32Array.BYTES_PER_ELEMENT;
const CLASSIFICATION_STATS_UINT_COUNT = 8;
const CLASSIFICATION_STATS_BUFFER_SIZE =
    CLASSIFICATION_STATS_UINT_COUNT * Uint32Array.BYTES_PER_ELEMENT;
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
    const computeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: 'uniform' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: {
                    access: 'write-only',
                    format: OUTPUT_TEXTURE_FORMAT,
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: 'storage' },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: 'storage' },
            },
            {
                binding: 4,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: 'storage' },
            },
        ],
    });
    const computePipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [computeBindGroupLayout],
    });
    const classifyPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: {
            module: shaderModule,
            entryPoint: 'cs_classify_main',
        },
    });
    const refineUnknownPipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: {
            module: shaderModule,
            entryPoint: 'cs_refine_unknown_main',
        },
    });
    const finalizePipeline = device.createComputePipeline({
        layout: computePipelineLayout,
        compute: {
            module: shaderModule,
            entryPoint: 'cs_finalize_main',
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
    let lastComputedSignature = null;

    function buildStateSignature(state) {
        return JSON.stringify({
            width: state.width,
            height: state.height,
            offsetX: state.offsetX,
            offsetY: state.offsetY,
            yReal: state.yReal,
            yImag: state.yImag,
            scale: state.scale,
            mode: state.mode,
            maxSinkIters: state.maxSinkIters,
            maxDfsDepth: state.maxDfsDepth,
            maxDfsVisits: state.maxDfsVisits,
        });
    }

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
            layout: computeBindGroupLayout,
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
        lastComputedSignature = null;
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

    function encodeClassificationPass(encoder, state) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(classifyPipeline);
        computePass.setBindGroup(0, computeBindGroup);
        computePass.dispatchWorkgroups(
            Math.ceil(state.width / WORKGROUP_SIZE),
            Math.ceil(state.height / WORKGROUP_SIZE),
        );
        computePass.end();
    }

    function encodeUnknownRefinementPass(encoder, state) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(refineUnknownPipeline);
        computePass.setBindGroup(0, computeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil((state.width * state.height) / 64));
        computePass.end();
    }

    function encodeFinalizePass(encoder, state) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(finalizePipeline);
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

    function encodeComputePasses(encoder, state) {
        encoder.clearBuffer(classificationStatsBuffer);
        encodeClassificationPass(encoder, state);
        encodeUnknownRefinementPass(encoder, state);
        encoder.clearBuffer(classificationStatsBuffer);
        encodeFinalizePass(encoder, state);
    }

    function encodeOutputCopies(
        encoder,
        state,
        {
            presentToCanvas = false,
            copyBuffer = null,
            copyUnknownIndices = null,
            copyStats = null,
        } = {},
    ) {
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

        if (copyUnknownIndices) {
            encoder.copyBufferToBuffer(
                unknownIndexBuffer,
                0,
                copyUnknownIndices.buffer,
                0,
                copyUnknownIndices.size,
            );
        }

        if (copyStats) {
            encoder.copyBufferToBuffer(
                classificationStatsBuffer,
                0,
                copyStats.buffer,
                0,
                CLASSIFICATION_STATS_BUFFER_SIZE,
            );
        }
    }

    async function submitAndWait(encoder) {
        const submitStart = performance.now();
        device.queue.submit([encoder.finish()]);
        const submitMs = performance.now() - submitStart;

        const waitStart = performance.now();
        await device.queue.onSubmittedWorkDone();
        const waitMs = performance.now() - waitStart;

        return { submitMs, waitMs };
    }

    function submitRender(
        state,
        {
            presentToCanvas = true,
            copyBuffer = null,
            copyUnknownIndices = null,
            copyStats = null,
        } = {},
    ) {
        ensureConfigured(state.width, state.height);
        writeUniforms(state);

        const encoder = device.createCommandEncoder();
        encodeComputePasses(encoder, state);
        encodeOutputCopies(encoder, state, {
            presentToCanvas,
            copyBuffer,
            copyUnknownIndices,
            copyStats,
        });

        device.queue.submit([encoder.finish()]);
        lastComputedSignature = buildStateSignature(state);
    }

    function submitReusePass(
        state,
        {
            presentToCanvas = false,
            copyBuffer = null,
            copyUnknownIndices = null,
            copyStats = null,
        } = {},
    ) {
        ensureConfigured(state.width, state.height);
        const encoder = device.createCommandEncoder();
        encodeOutputCopies(encoder, state, {
            presentToCanvas,
            copyBuffer,
            copyUnknownIndices,
            copyStats,
        });
        device.queue.submit([encoder.finish()]);
    }

    function hasComputedState(state) {
        return lastComputedSignature === buildStateSignature(state);
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

        if (hasComputedState(state)) {
            submitReusePass(state, {
                copyBuffer: {
                    buffer: outputBuffer,
                    bytesPerRow: paddedBytesPerRow,
                },
            });
        } else {
            submitRender(state, {
                presentToCanvas: false,
                copyBuffer: {
                    buffer: outputBuffer,
                    bytesPerRow: paddedBytesPerRow,
                },
            });
        }

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

        const encoder = device.createCommandEncoder();
        writeUniforms(state);
        encoder.clearBuffer(classificationStatsBuffer);
        encodeClassificationPass(encoder, state);
        encodeUnknownRefinementPass(encoder, state);
        encoder.clearBuffer(classificationStatsBuffer);
        encodeFinalizePass(encoder, state);
        encoder.copyBufferToBuffer(pixelStateBuffer, offset, outputBuffer, 0, PIXEL_STATE_STRIDE);
        device.queue.submit([encoder.finish()]);

        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const mapped = outputBuffer.getMappedRange();
        const values = new Float32Array(mapped.slice(0));
        outputBuffer.unmap();
        outputBuffer.destroy();

        const statusCode = Math.round(values[6]);
        const statusName =
            statusCode === 1
                ? 'true'
                : statusCode === 2
                  ? 'unknown_sink'
                  : statusCode === 3
                    ? 'unknown_dfs_limit'
                    : statusCode === 4
                      ? 'unknown_stack'
                      : 'false';

        return {
            x: { real: values[0], imag: values[1] },
            y: { real: values[2], imag: values[3] },
            z: { real: values[4], imag: values[5] },
            statusCode,
            statusName,
            isBqLike: statusCode !== 0,
            reserved: values[7],
        };
    }

    async function readClassificationStats(state) {
        ensureConfigured(state.width, state.height);

        const outputBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        if (hasComputedState(state)) {
            submitReusePass(state, {
                copyStats: {
                    buffer: outputBuffer,
                },
            });
        } else {
            submitRender(state, {
                presentToCanvas: false,
                copyStats: {
                    buffer: outputBuffer,
                },
            });
        }

        await device.queue.onSubmittedWorkDone();
        await outputBuffer.mapAsync(GPUMapMode.READ);

        const values = new Uint32Array(outputBuffer.getMappedRange().slice(0));
        outputBuffer.unmap();
        outputBuffer.destroy();

        return {
            falseCount: values[0],
            trueCount: values[1],
            unknownCount: values[2],
            unknownSinkCount: values[3],
            unknownDfsLimitCount: values[4],
            unknownStackCount: values[5],
            totalCount: values[0] + values[1] + values[2],
        };
    }

    async function readUnknownPixelIndexBuffer(state, limit = 256) {
        const payload = await readUnknownPixelIndexBufferSinglePass(state, {
            presentToCanvas: false,
        });
        const clampedLimit = Math.max(0, Math.min(limit, payload.unknownCount));
        const indices = payload.indices.slice(0, clampedLimit);

        return {
            unknownCount: payload.unknownCount,
            returnedCount: indices.length,
            truncated: clampedLimit < payload.unknownCount,
            indices,
        };
    }

    async function readUnknownPixelIndexBufferSinglePass(state, { presentToCanvas = false } = {}) {
        ensureConfigured(state.width, state.height);

        const statsReadBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const unknownReadBuffer = device.createBuffer({
            size: state.width * state.height * UNKNOWN_INDEX_STRIDE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const cpuStart = performance.now();
        if (hasComputedState(state)) {
            submitReusePass(state, {
                presentToCanvas,
                copyStats: {
                    buffer: statsReadBuffer,
                },
                copyUnknownIndices: {
                    buffer: unknownReadBuffer,
                    size: state.width * state.height * UNKNOWN_INDEX_STRIDE,
                },
            });
        } else {
            submitRender(state, {
                presentToCanvas,
                copyStats: {
                    buffer: statsReadBuffer,
                },
                copyUnknownIndices: {
                    buffer: unknownReadBuffer,
                    size: state.width * state.height * UNKNOWN_INDEX_STRIDE,
                },
            });
        }
        lastCpuRenderMs = performance.now() - cpuStart;

        await device.queue.onSubmittedWorkDone();
        await Promise.all([
            statsReadBuffer.mapAsync(GPUMapMode.READ),
            unknownReadBuffer.mapAsync(GPUMapMode.READ),
        ]);

        const statsValues = new Uint32Array(statsReadBuffer.getMappedRange().slice(0));
        const unknownCount = statsValues[2];
        const rawIndices = new Uint32Array(unknownReadBuffer.getMappedRange().slice(0));
        const indices = rawIndices.slice(0, unknownCount);

        statsReadBuffer.unmap();
        statsReadBuffer.destroy();
        unknownReadBuffer.unmap();
        unknownReadBuffer.destroy();

        return {
            unknownCount,
            returnedCount: indices.length,
            truncated: false,
            indices,
        };
    }

    async function measureHybridUnknownPass(state, { presentToCanvas = false } = {}) {
        ensureConfigured(state.width, state.height);
        writeUniforms(state);

        const classifyEncoder = device.createCommandEncoder();
        classifyEncoder.clearBuffer(classificationStatsBuffer);
        encodeClassificationPass(classifyEncoder, state);
        const classifyTiming = await submitAndWait(classifyEncoder);

        const refineEncoder = device.createCommandEncoder();
        encodeUnknownRefinementPass(refineEncoder, state);
        const refineTiming = await submitAndWait(refineEncoder);

        const statsReadBuffer = device.createBuffer({
            size: CLASSIFICATION_STATS_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const unknownReadBuffer = device.createBuffer({
            size: state.width * state.height * UNKNOWN_INDEX_STRIDE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const finalizeEncoder = device.createCommandEncoder();
        finalizeEncoder.clearBuffer(classificationStatsBuffer);
        encodeFinalizePass(finalizeEncoder, state);
        if (presentToCanvas) {
            encodeBlitPass(finalizeEncoder, context.getCurrentTexture().createView());
        }
        finalizeEncoder.copyBufferToBuffer(
            classificationStatsBuffer,
            0,
            statsReadBuffer,
            0,
            CLASSIFICATION_STATS_BUFFER_SIZE,
        );
        finalizeEncoder.copyBufferToBuffer(
            unknownIndexBuffer,
            0,
            unknownReadBuffer,
            0,
            state.width * state.height * UNKNOWN_INDEX_STRIDE,
        );
        const finalizeTiming = await submitAndWait(finalizeEncoder);

        const statsMapStart = performance.now();
        await statsReadBuffer.mapAsync(GPUMapMode.READ);
        const statsMapMs = performance.now() - statsMapStart;
        const statsValues = new Uint32Array(statsReadBuffer.getMappedRange().slice(0));
        const unknownCount = statsValues[2];

        const unknownMapStart = performance.now();
        await unknownReadBuffer.mapAsync(GPUMapMode.READ);
        const unknownMapMs = performance.now() - unknownMapStart;
        const rawIndices = new Uint32Array(unknownReadBuffer.getMappedRange().slice(0));
        const indices = rawIndices.slice(0, unknownCount);

        statsReadBuffer.unmap();
        statsReadBuffer.destroy();
        unknownReadBuffer.unmap();
        unknownReadBuffer.destroy();

        return {
            unknownCount,
            returnedCount: indices.length,
            truncated: false,
            indices,
            timing: {
                classifySubmitMs: classifyTiming.submitMs,
                classifyWaitMs: classifyTiming.waitMs,
                refineSubmitMs: refineTiming.submitMs,
                refineWaitMs: refineTiming.waitMs,
                finalizeSubmitMs: finalizeTiming.submitMs,
                finalizeWaitMs: finalizeTiming.waitMs,
                statsMapMs,
                unknownMapMs,
            },
        };
    }

    async function readUnknownPixelIndices(state, limit = 256) {
        const payload = await readUnknownPixelIndexBuffer(state, limit);
        return {
            ...payload,
            indices: Array.from(payload.indices, (index) => ({
                index,
                x: index % state.width,
                y: Math.floor(index / state.width),
            })),
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
        readUnknownPixelIndexBuffer,
        readUnknownPixelIndexBufferSinglePass,
        measureHybridUnknownPass,
        readUnknownPixelIndices,
        getTiming() {
            return { lastCpuRenderMs, lastGpuRenderMs: null };
        },
    };
}
