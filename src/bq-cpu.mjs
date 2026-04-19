function complex(re, im = 0) {
    return { re, im };
}

function cAdd(a, b) {
    return complex(a.re + b.re, a.im + b.im);
}

function cSub(a, b) {
    return complex(a.re - b.re, a.im - b.im);
}

function cMul(a, b) {
    return complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

function cDiv(a, b) {
    const denom = Math.max(b.re * b.re + b.im * b.im, 1e-12);
    return complex(
        (a.re * b.re + a.im * b.im) / denom,
        (a.im * b.re - a.re * b.im) / denom,
    );
}

function cAbs(z) {
    return Math.hypot(z.re, z.im);
}

function cSqrt(z) {
    const r = Math.hypot(z.re, z.im);
    const realPart = Math.sqrt(Math.max(0, 0.5 * (r + z.re)));
    let imagPart = Math.sqrt(Math.max(0, 0.5 * (r - z.re)));
    if (z.im < 0) imagPart = -imagPart;
    return complex(realPart, imagPart);
}

function hBound(x) {
    const xx = cMul(x, x);
    const root = cSqrt(cSub(xx, complex(4, 0)));
    let lambdaAbs = cAbs(cMul(complex(0.5, 0), cAdd(x, root)));
    lambdaAbs = Math.max(lambdaAbs, 1 / Math.max(lambdaAbs, 1e-12));
    const prefactor = Math.sqrt(cAbs(cDiv(xx, cSub(xx, complex(4, 0)))));
    return (prefactor * (2 * lambdaAbs * lambdaAbs)) / Math.max(lambdaAbs - 1, 1e-12);
}

function isBq1Failure(z) {
    return Math.abs(z.im) <= 1e-10 && z.re >= -2 && z.re <= 2;
}

function sinkToLocalMinimum(a0, b0, c0, maxSinkIters = 1_000_000) {
    let a = a0;
    let b = b0;
    let c = c0;

    if (cAbs(a) < 0.5 || cAbs(b) < 0.5 || cAbs(c) < 0.5) {
        return { status: 'false' };
    }

    for (let iter = 0; iter < maxSinkIters; iter += 1) {
        const A = cSub(cMul(b, c), a);
        const B = cSub(cMul(c, a), b);
        const C = cSub(cMul(a, b), c);

        const absA = cAbs(A);
        const absB = cAbs(B);
        const absC = cAbs(C);

        if (absA < 0.5 || absB < 0.5 || absC < 0.5) {
            return { status: 'false' };
        }

        if (absA < cAbs(a)) {
            a = A;
            continue;
        }
        if (absB < cAbs(b)) {
            b = B;
            continue;
        }
        if (absC < cAbs(c)) {
            c = C;
            continue;
        }

        return { status: 'sink', a, b, c };
    }

    return { status: 'giveup' };
}

function bqDfs(a, b, c, depth, state) {
    state.visits += 1;
    if (state.visits > state.maxVisits) return true;
    if (depth > state.maxDepth) return true;
    if (isBq1Failure(b) || isBq1Failure(c)) return false;

    const absb = cAbs(b);
    const absc = cAbs(c);
    const inTree = (absb <= 3 && absc <= hBound(b) + 1) || (absc <= 3 && absb <= hBound(c) + 1);
    if (!inTree) return true;

    const d = cSub(cMul(b, c), a);
    if (cAbs(d) < 0.5) return false;

    return bqDfs(b, c, d, depth + 1, state) && bqDfs(c, b, d, depth + 1, state);
}

export function evaluateBqPixel(renderState, index, options = {}) {
    const width = renderState.width;
    const xIndex = index % width;
    const yIndex = Math.floor(index / width);
    const frag = complex(xIndex + 0.5, yIndex + 0.5);
    const planeX = complex(
        (frag.re - renderState.width * 0.5) / renderState.scale + renderState.offsetX,
        (frag.im - renderState.height * 0.5) / renderState.scale + renderState.offsetY,
    );
    const planeY = complex(renderState.yReal, renderState.yImag);

    const xx = cMul(planeX, planeX);
    const yy = cMul(planeY, planeY);
    const xy = cMul(planeX, planeY);
    const discriminant = cSub(cMul(xy, xy), cMul(complex(4, 0), cAdd(xx, yy)));
    const z = cMul(complex(0.5, 0), cAdd(xy, cSqrt(discriminant)));

    const sink = sinkToLocalMinimum(planeX, planeY, z, options.maxSinkIters);
    if (sink.status === 'false') return false;
    if (sink.status === 'giveup') return true;

    const createDfsState = () => ({
        maxDepth: options.maxDepth ?? 995,
        maxVisits: options.maxVisits ?? Number.POSITIVE_INFINITY,
        visits: 0,
    });

    return (
        bqDfs(sink.a, sink.b, sink.c, 0, createDfsState()) &&
        bqDfs(sink.b, sink.c, sink.a, 0, createDfsState()) &&
        bqDfs(sink.c, sink.b, sink.a, 0, createDfsState())
    );
}

function getUnknownPixelIndex(entry) {
    return typeof entry === 'number' ? entry : entry.index;
}

export function refineUnknownMask(renderState, candidateMask, unknownPixels, options = {}) {
    const refinedMask = new Uint8Array(candidateMask);
    let resolvedTrue = 0;
    let resolvedFalse = 0;

    for (const pixel of unknownPixels) {
        const index = getUnknownPixelIndex(pixel);
        const x = index % renderState.width;
        const y = Math.floor(index / renderState.width);
        const targetIndex = (renderState.height - 1 - y) * renderState.width + x;
        const nextValue = evaluateBqPixel(renderState, index, options) ? 1 : 0;
        refinedMask[targetIndex] = nextValue;
        if (nextValue === 1) {
            resolvedTrue += 1;
        } else {
            resolvedFalse += 1;
        }
    }

    return {
        refinedMask,
        resolvedCount: unknownPixels.length,
        resolvedTrue,
        resolvedFalse,
    };
}
