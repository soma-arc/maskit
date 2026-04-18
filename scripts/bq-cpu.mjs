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
  return complex((a.re * b.re + a.im * b.im) / denom, (a.im * b.re - a.re * b.im) / denom);
}

function cAbs2(z) {
  return z.re * z.re + z.im * z.im;
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

function sinkToLocalMinimum(a0, b0, c0, maxSinkIters = 4096) {
  let a = a0;
  let b = b0;
  let c = c0;

  if (cAbs2(a) < 0.25 || cAbs2(b) < 0.25 || cAbs2(c) < 0.25) {
    return { status: 'false' };
  }

  for (let iter = 0; iter < maxSinkIters; iter += 1) {
    const A = cSub(cMul(b, c), a);
    const B = cSub(cMul(c, a), b);
    const C = cSub(cMul(a, b), c);

    const absA2 = cAbs2(A);
    const absB2 = cAbs2(B);
    const absC2 = cAbs2(C);

    if (absA2 < 0.25 || absB2 < 0.25 || absC2 < 0.25) {
      return { status: 'false' };
    }

    if (absA2 < cAbs2(a)) {
      a = A;
      continue;
    }
    if (absB2 < cAbs2(b)) {
      b = B;
      continue;
    }
    if (absC2 < cAbs2(c)) {
      c = C;
      continue;
    }

    return { status: 'sink', a, b, c };
  }

  return { status: 'giveup' };
}

function bqDfs(a0, b0, c0, options = {}) {
  const maxDepth = options.maxDepth ?? 995;
  const maxVisits = options.maxVisits ?? 1_000_000;
  const stack = [{ a: a0, b: b0, c: c0, depth: 0 }];
  let visits = 0;

  while (stack.length > 0) {
    visits += 1;
    if (visits > maxVisits) return true;

    const { a, b, c, depth } = stack.pop();
    if (depth > maxDepth) return true;
    if (isBq1Failure(b) || isBq1Failure(c)) return false;

    const absb2 = cAbs2(b);
    const absc2 = cAbs2(c);
    const hBoundB = hBound(b) + 1;
    const hBoundC = hBound(c) + 1;
    const inTree =
      (absb2 <= 9 && absc2 <= hBoundB * hBoundB) ||
      (absc2 <= 9 && absb2 <= hBoundC * hBoundC);
    if (!inTree) continue;

    const d = cSub(cMul(b, c), a);
    if (cAbs2(d) < 0.25) return false;

    stack.push({ a: c, b, c: d, depth: depth + 1 });
    stack.push({ a: b, b: c, c: d, depth: depth + 1 });
  }

  return true;
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

  return (
    bqDfs(sink.a, sink.b, sink.c, options) &&
    bqDfs(sink.b, sink.c, sink.a, options) &&
    bqDfs(sink.c, sink.b, sink.a, options)
  );
}

export function refineUnknownMask(renderState, candidateMask, unknownPixels, options = {}) {
  const refinedMask = new Uint8Array(candidateMask);
  let resolvedTrue = 0;
  let resolvedFalse = 0;

  for (const pixel of unknownPixels) {
    const targetIndex =
      (renderState.height - 1 - pixel.y) * renderState.width + pixel.x;
    const nextValue = evaluateBqPixel(renderState, pixel.index, options) ? 1 : 0;
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
