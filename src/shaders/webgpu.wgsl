struct Uniforms {
    resolution: vec2f,
    offset: vec2f,
    y: vec2f,
    scale: f32,
    mode: f32,
    maxSinkIters: f32,
    maxDfsDepth: f32,
    maxDfsVisits: f32,
};

struct PixelState {
    xy: vec4f,
    zStatus: vec4f,
};

struct ComputedSample {
    x: vec2f,
    y: vec2f,
    z: vec2f,
    discriminant: vec2f,
    statusCode: f32,
};

struct ClassificationStats {
    falseCount: atomic<u32>,
    trueCount: atomic<u32>,
    unknownCount: atomic<u32>,
    unknownSinkCount: atomic<u32>,
    unknownDfsLimitCount: atomic<u32>,
    unknownStackCount: atomic<u32>,
    padding0: u32,
    padding1: u32,
};

struct BlitVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read_write> pixelStates: array<PixelState>;
@group(0) @binding(3) var<storage, read_write> classificationStats: ClassificationStats;
@group(0) @binding(4) var<storage, read_write> unknownIndices: array<u32>;

@group(1) @binding(0) var outputSampler: sampler;
@group(1) @binding(1) var outputTextureForSampling: texture_2d<f32>;

const MAX_SINK_ITERS_LIMIT: i32 = 64;
const MAX_DFS_DEPTH_LIMIT: i32 = 512;
const MAX_DFS_STACK: i32 = 384;
const MAX_DFS_VISITS_LIMIT: i32 = 65536;
const REFINEMENT_DFS_DEPTH_LIMIT: i32 = 512;
const REFINEMENT_DFS_VISITS_LIMIT: i32 = 65536;
const BQ_FALSE: i32 = 0;
const BQ_TRUE: i32 = 1;
const BQ_UNKNOWN_SINK: i32 = 2;
const BQ_UNKNOWN_DFS_LIMIT: i32 = 3;
const BQ_UNKNOWN_STACK: i32 = 4;

fn c_mul(a: vec2f, b: vec2f) -> vec2f {
    return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn c_div(a: vec2f, b: vec2f) -> vec2f {
    let denom = max(dot(b, b), 1e-6);
    return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / denom;
}

fn c_abs2(z: vec2f) -> f32 {
    return dot(z, z);
}

fn c_abs(z: vec2f) -> f32 {
    return sqrt(c_abs2(z));
}

fn c_sqrt(z: vec2f) -> vec2f {
    let r = length(z);
    let realPart = sqrt(max(0.0, 0.5 * (r + z.x)));
    var imagPart = sqrt(max(0.0, 0.5 * (r - z.x)));
    if (z.y < 0.0) {
        imagPart = -imagPart;
    }
    return vec2f(realPart, imagPart);
}

fn signed_to_unit(value: f32) -> f32 {
    return 0.5 + 0.5 * (value / (1.0 + abs(value)));
}

fn heat(value: f32, exposure: f32) -> vec3f {
    let t = clamp(1.0 - exp(-value * exposure), 0.0, 1.0);
    return mix(vec3f(0.02, 0.05, 0.12), vec3f(0.92, 0.78, 0.34), vec3f(t * t));
}

fn h_bound(x: vec2f) -> f32 {
    let xx = c_mul(x, x);
    let root = c_sqrt(xx - vec2f(4.0, 0.0));
    var lambdaAbs = c_abs(0.5 * (x + root));
    lambdaAbs = max(lambdaAbs, 1.0 / max(lambdaAbs, 1e-6));
    let prefactor = sqrt(c_abs(c_div(xx, xx - vec2f(4.0, 0.0))));
    return prefactor * (2.0 * lambdaAbs * lambdaAbs) / max(lambdaAbs - 1.0, 1e-6);
}

fn initial_sink_limit() -> i32 {
    return clamp(i32(uniforms.maxSinkIters), 1, MAX_SINK_ITERS_LIMIT);
}

fn initial_dfs_depth_limit() -> i32 {
    return clamp(i32(uniforms.maxDfsDepth), 1, MAX_DFS_DEPTH_LIMIT);
}

fn initial_dfs_visits_limit() -> i32 {
    return clamp(i32(uniforms.maxDfsVisits), 1, MAX_DFS_VISITS_LIMIT);
}

fn refinement_dfs_depth_limit() -> i32 {
    let base = max(i32(uniforms.maxDfsDepth), 1);
    return clamp(max(base * 2, base + 64), 1, REFINEMENT_DFS_DEPTH_LIMIT);
}

fn refinement_dfs_visits_limit() -> i32 {
    let base = max(i32(uniforms.maxDfsVisits), 1);
    return clamp(max(base * 4, base + 4096), 1, REFINEMENT_DFS_VISITS_LIMIT);
}

fn bq_sink_to_local_minimum(
    a0: vec2f,
    b0: vec2f,
    c0: vec2f,
    maxSinkIters: i32,
) -> array<vec2f, 4> {
    var a = a0;
    var b = b0;
    var c = c0;
    if (c_abs2(a) < 0.25 || c_abs2(b) < 0.25 || c_abs2(c) < 0.25) {
        return array<vec2f, 4>(vec2f(f32(BQ_FALSE), 0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0));
    }

    for (var iter = 0; iter < MAX_SINK_ITERS_LIMIT; iter += 1) {
        if (iter >= maxSinkIters) {
            return array<vec2f, 4>(vec2f(f32(BQ_UNKNOWN_SINK), 0.0), a, b, c);
        }

        let A = c_mul(b, c) - a;
        let B = c_mul(c, a) - b;
        let C = c_mul(a, b) - c;

        let absA2 = c_abs2(A);
        let absB2 = c_abs2(B);
        let absC2 = c_abs2(C);
        let absa2 = c_abs2(a);
        let absb2 = c_abs2(b);
        let absc2 = c_abs2(c);

        if (absA2 < 0.25 || absB2 < 0.25 || absC2 < 0.25) {
            return array<vec2f, 4>(vec2f(f32(BQ_FALSE), 0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0));
        }

        if (absA2 < absa2) {
            a = A;
            continue;
        }
        if (absB2 < absb2) {
            b = B;
            continue;
        }
        if (absC2 < absc2) {
            c = C;
            continue;
        }

        return array<vec2f, 4>(vec2f(f32(BQ_TRUE), 0.0), a, b, c);
    }

    return array<vec2f, 4>(vec2f(f32(BQ_UNKNOWN_SINK), 0.0), a, b, c);
}

fn is_bq1_failure(z: vec2f) -> bool {
    return abs(z.y) <= 1e-5 && z.x >= -2.0 && z.x <= 2.0;
}

fn bq_dfs_bounded_result(
    a0: vec2f,
    b0: vec2f,
    c0: vec2f,
    maxDfsDepth: i32,
    maxDfsVisits: i32,
) -> i32 {
    var stackA: array<vec2f, MAX_DFS_STACK>;
    var stackB: array<vec2f, MAX_DFS_STACK>;
    var stackC: array<vec2f, MAX_DFS_STACK>;
    var stackDepth: array<i32, MAX_DFS_STACK>;

    var currentA = a0;
    var currentB = b0;
    var currentC = c0;
    var currentDepth = 0;
    var stackSize = 0;

    for (var visit = 0; visit < MAX_DFS_VISITS_LIMIT; visit += 1) {
        if (visit >= maxDfsVisits) {
            return BQ_UNKNOWN_DFS_LIMIT;
        }

        if (currentDepth > maxDfsDepth || currentDepth > MAX_DFS_DEPTH_LIMIT) {
            return BQ_UNKNOWN_DFS_LIMIT;
        }

        if (is_bq1_failure(currentB) || is_bq1_failure(currentC)) {
            return BQ_FALSE;
        }

        let absb2 = c_abs2(currentB);
        let absc2 = c_abs2(currentC);
        let hBoundB = h_bound(currentB) + 1.0;
        let hBoundC = h_bound(currentC) + 1.0;
        let inTree = (absb2 <= 9.0 && absc2 <= hBoundB * hBoundB) ||
            (absc2 <= 9.0 && absb2 <= hBoundC * hBoundC);
        if (!inTree) {
            if (stackSize <= 0) {
                return BQ_TRUE;
            }
            stackSize -= 1;
            currentA = stackA[stackSize];
            currentB = stackB[stackSize];
            currentC = stackC[stackSize];
            currentDepth = stackDepth[stackSize];
            continue;
        }

        let d = c_mul(currentB, currentC) - currentA;
        if (c_abs2(d) < 0.25) {
            return BQ_FALSE;
        }

        if (stackSize + 1 > MAX_DFS_STACK) {
            return BQ_UNKNOWN_STACK;
        }

        stackA[stackSize] = currentC;
        stackB[stackSize] = currentB;
        stackC[stackSize] = d;
        stackDepth[stackSize] = currentDepth + 1;
        stackSize += 1;

        currentA = currentB;
        currentB = currentC;
        currentC = d;
        currentDepth += 1;
    }

    return BQ_UNKNOWN_DFS_LIMIT;
}

fn bq_bounded_result(
    a: vec2f,
    b: vec2f,
    c: vec2f,
    maxSinkIters: i32,
    maxDfsDepth: i32,
    maxDfsVisits: i32,
) -> i32 {
    let sink = bq_sink_to_local_minimum(a, b, c, maxSinkIters);
    let sinkStatus = i32(sink[0].x);
    if (sinkStatus == BQ_FALSE) {
        return BQ_FALSE;
    }
    if (sinkStatus == BQ_UNKNOWN_SINK) {
        return BQ_UNKNOWN_SINK;
    }

    let sinkA = sink[1];
    let sinkB = sink[2];
    let sinkC = sink[3];

    let result1 = bq_dfs_bounded_result(sinkA, sinkB, sinkC, maxDfsDepth, maxDfsVisits);
    let result2 = bq_dfs_bounded_result(sinkB, sinkC, sinkA, maxDfsDepth, maxDfsVisits);
    let result3 = bq_dfs_bounded_result(sinkC, sinkB, sinkA, maxDfsDepth, maxDfsVisits);

    if (result1 == BQ_FALSE || result2 == BQ_FALSE || result3 == BQ_FALSE) {
        return BQ_FALSE;
    }
    if (
        result1 == BQ_UNKNOWN_STACK ||
        result2 == BQ_UNKNOWN_STACK ||
        result3 == BQ_UNKNOWN_STACK
    ) {
        return BQ_UNKNOWN_STACK;
    }
    if (
        result1 == BQ_UNKNOWN_DFS_LIMIT ||
        result2 == BQ_UNKNOWN_DFS_LIMIT ||
        result3 == BQ_UNKNOWN_DFS_LIMIT
    ) {
        return BQ_UNKNOWN_DFS_LIMIT;
    }
    return BQ_TRUE;
}

fn computeSample(fragCoord: vec2f) -> ComputedSample {
    let x = (fragCoord - uniforms.resolution * 0.5) / uniforms.scale + uniforms.offset;
    let y = uniforms.y;

    let xx = c_mul(x, x);
    let yy = c_mul(y, y);
    let xy = c_mul(x, y);
    let discriminant = c_mul(xy, xy) - 4.0 * (xx + yy);
    let z = 0.5 * (xy + c_sqrt(discriminant));

    return ComputedSample(
        x,
        y,
        z,
        discriminant,
        f32(
            bq_bounded_result(
                x,
                y,
                z,
                initial_sink_limit(),
                initial_dfs_depth_limit(),
                initial_dfs_visits_limit(),
            ),
        ),
    );
}

fn computeColor(sample: ComputedSample) -> vec4f {
    return computeColorFromStatus(i32(sample.statusCode), sample.x, sample.z, sample.discriminant);
}

fn computeColorFromStatus(
    statusCode: i32,
    x: vec2f,
    z: vec2f,
    discriminant: vec2f,
) -> vec4f {
    let mode = i32(uniforms.mode);
    var color = vec3f(0.0);

    if (mode == 0) {
        let grid = abs(fract(x) - vec2f(0.5));
        let line = 1.0 - smoothstep(0.45, 0.5, min(grid.x, grid.y));
        color = mix(
            vec3f(fract(x.x * 0.125), fract(x.y * 0.125), 0.18),
            vec3f(0.92, 0.94, 0.98),
            vec3f(line * 0.35),
        );
    } else if (mode == 1) {
        color = vec3f(signed_to_unit(z.x), signed_to_unit(z.y), 0.18);
    } else if (mode == 2) {
        color = heat(c_abs(z), 0.08);
    } else if (mode == 3) {
        color = heat(c_abs(discriminant), 0.015);
    } else if (mode == 4) {
        color = heat(h_bound(x), 0.01);
    } else if (mode == 5) {
        color = select(vec3f(1.0), vec3f(0.0), statusCode == BQ_TRUE);
    } else {
        if (statusCode == BQ_TRUE) {
            color = vec3f(0.0, 0.0, 0.0);
        } else if (statusCode == BQ_UNKNOWN_DFS_LIMIT) {
            color = vec3f(0.93, 0.31, 0.19);
        } else if (statusCode == BQ_UNKNOWN_STACK) {
            color = vec3f(0.72, 0.29, 0.94);
        } else if (statusCode == BQ_UNKNOWN_SINK) {
            color = vec3f(0.96, 0.68, 0.14);
        } else {
            color = vec3f(1.0, 1.0, 1.0);
        }
    }

    return vec4f(color, 1.0);
}

fn buildPixelState(sample: ComputedSample) -> PixelState {
    return PixelState(
        vec4f(sample.x, sample.y),
        vec4f(sample.z, sample.statusCode, 0.0),
    );
}

fn accumulateClassificationStats(statusCode: u32, stateIndex: u32) {
    if (statusCode == u32(BQ_TRUE)) {
        atomicAdd(&classificationStats.trueCount, 1u);
    } else if (statusCode == u32(BQ_UNKNOWN_SINK)) {
        let slot = atomicAdd(&classificationStats.unknownCount, 1u);
        atomicAdd(&classificationStats.unknownSinkCount, 1u);
        unknownIndices[slot] = stateIndex;
    } else if (statusCode == u32(BQ_UNKNOWN_DFS_LIMIT)) {
        let slot = atomicAdd(&classificationStats.unknownCount, 1u);
        atomicAdd(&classificationStats.unknownDfsLimitCount, 1u);
        unknownIndices[slot] = stateIndex;
    } else if (statusCode == u32(BQ_UNKNOWN_STACK)) {
        let slot = atomicAdd(&classificationStats.unknownCount, 1u);
        atomicAdd(&classificationStats.unknownStackCount, 1u);
        unknownIndices[slot] = stateIndex;
    } else {
        atomicAdd(&classificationStats.falseCount, 1u);
    }
}

@compute @workgroup_size(8, 8, 1)
fn cs_classify_main(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x >= u32(uniforms.resolution.x) || globalId.y >= u32(uniforms.resolution.y)) {
        return;
    }

    let pixelCoord = vec2f(globalId.xy) + vec2f(0.5, 0.5);
    let stateIndex = globalId.y * u32(uniforms.resolution.x) + globalId.x;
    let sample = computeSample(pixelCoord);
    let pixelState = buildPixelState(sample);
    pixelStates[stateIndex] = pixelState;
    accumulateClassificationStats(u32(sample.statusCode), stateIndex);
}

@compute @workgroup_size(64, 1, 1)
fn cs_refine_unknown_main(@builtin(global_invocation_id) globalId: vec3u) {
    let unknownIndex = globalId.x;
    let unknownCount = atomicLoad(&classificationStats.unknownCount);
    if (unknownIndex >= unknownCount) {
        return;
    }

    let stateIndex = unknownIndices[unknownIndex];
    let pixelState = pixelStates[stateIndex];
    let statusCode = i32(pixelState.zStatus.z);
    if (statusCode != BQ_UNKNOWN_DFS_LIMIT) {
        return;
    }

    let refinedStatus = bq_bounded_result(
        pixelState.xy.xy,
        pixelState.xy.zw,
        pixelState.zStatus.xy,
        initial_sink_limit(),
        refinement_dfs_depth_limit(),
        refinement_dfs_visits_limit(),
    );
    pixelStates[stateIndex].zStatus.z = f32(refinedStatus);
}


@compute @workgroup_size(8, 8, 1)
fn cs_finalize_main(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x >= u32(uniforms.resolution.x) || globalId.y >= u32(uniforms.resolution.y)) {
        return;
    }

    let stateIndex = globalId.y * u32(uniforms.resolution.x) + globalId.x;
    let pixelState = pixelStates[stateIndex];
    let statusCode = i32(pixelState.zStatus.z);
    let x = pixelState.xy.xy;
    let z = pixelState.zStatus.xy;
    let xy = c_mul(x, pixelState.xy.zw);
    let discriminant = c_mul(xy, xy) - 4.0 * (c_mul(x, x) + c_mul(pixelState.xy.zw, pixelState.xy.zw));

    accumulateClassificationStats(u32(statusCode), stateIndex);
    textureStore(
        outputTexture,
        vec2i(globalId.xy),
        computeColorFromStatus(statusCode, x, z, discriminant),
    );
}

@vertex
fn blit_vs_main(@builtin(vertex_index) vertexIndex: u32) -> BlitVertexOutput {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -3.0),
        vec2f(-1.0, 1.0),
        vec2f(3.0, 1.0),
    );

    let position = positions[vertexIndex];
    var output: BlitVertexOutput;
    output.position = vec4f(position, 0.0, 1.0);
    output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
    return output;
}

@fragment
fn blit_fs_main(input: BlitVertexOutput) -> @location(0) vec4f {
    return textureSampleLevel(outputTextureForSampling, outputSampler, input.uv, 0.0);
}
