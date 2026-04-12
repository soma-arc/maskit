#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform vec2 u_y;
uniform float u_scale;
uniform int u_mode;
uniform int u_max_sink_iters;
uniform int u_max_dfs_depth;
uniform int u_max_dfs_visits;

const int MAX_SINK_ITERS_LIMIT = 64;
const int MAX_DFS_DEPTH_LIMIT = 96;
const int MAX_DFS_STACK = 128;
const int MAX_DFS_VISITS_LIMIT = 512;

vec2 c_mul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 c_div(vec2 a, vec2 b) {
  float denom = max(dot(b, b), 1e-6);
  return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / denom;
}

float c_abs2(vec2 z) {
  return dot(z, z);
}

float c_abs(vec2 z) {
  return sqrt(c_abs2(z));
}

vec2 c_sqrt(vec2 z) {
  float r = length(z);
  float realPart = sqrt(max(0.0, 0.5 * (r + z.x)));
  float imagPart = sqrt(max(0.0, 0.5 * (r - z.x)));
  if (z.y < 0.0) {
    imagPart = -imagPart;
  }
  return vec2(realPart, imagPart);
}

float signed_to_unit(float value) {
  return 0.5 + 0.5 * (value / (1.0 + abs(value)));
}

vec3 heat(float value, float exposure) {
  float t = clamp(1.0 - exp(-value * exposure), 0.0, 1.0);
  return mix(
    vec3(0.02, 0.05, 0.12),
    vec3(0.92, 0.78, 0.34),
    vec3(t * t)
  );
}

float h_bound(vec2 x) {
  vec2 xx = c_mul(x, x);
  vec2 root = c_sqrt(xx - vec2(4.0, 0.0));
  float lambdaAbs = c_abs(0.5 * (x + root));
  lambdaAbs = max(lambdaAbs, 1.0 / max(lambdaAbs, 1e-6));
  float prefactor = sqrt(c_abs(c_div(xx, xx - vec2(4.0, 0.0))));
  return prefactor * (2.0 * lambdaAbs * lambdaAbs) / max(lambdaAbs - 1.0, 1e-6);
}

bool bq_sink_to_local_minimum(vec2 a, vec2 b, vec2 c, out vec2 sinkA, out vec2 sinkB, out vec2 sinkC) {
  if (c_abs2(a) < 0.25 || c_abs2(b) < 0.25 || c_abs2(c) < 0.25) {
    return false;
  }

  for (int iter = 0; iter < MAX_SINK_ITERS_LIMIT; iter++) {
    if (iter >= u_max_sink_iters) {
      sinkA = a;
      sinkB = b;
      sinkC = c;
      return true;
    }
    vec2 A = c_mul(b, c) - a;
    vec2 B = c_mul(c, a) - b;
    vec2 C = c_mul(a, b) - c;

    float absA2 = c_abs2(A);
    float absB2 = c_abs2(B);
    float absC2 = c_abs2(C);
    float absa2 = c_abs2(a);
    float absb2 = c_abs2(b);
    float absc2 = c_abs2(c);

    if (absA2 < 0.25 || absB2 < 0.25 || absC2 < 0.25) {
      return false;
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

    sinkA = a;
    sinkB = b;
    sinkC = c;
    return true;
  }

  sinkA = a;
  sinkB = b;
  sinkC = c;
  return true;
}

bool is_bq1_failure(vec2 z) {
  return abs(z.y) <= 1e-5 && z.x >= -2.0 && z.x <= 2.0;
}

bool bq_dfs_bounded(vec2 a0, vec2 b0, vec2 c0) {
  vec2 stackA[MAX_DFS_STACK];
  vec2 stackB[MAX_DFS_STACK];
  vec2 stackC[MAX_DFS_STACK];
  int stackDepth[MAX_DFS_STACK];

  int stackSize = 1;
  stackA[0] = a0;
  stackB[0] = b0;
  stackC[0] = c0;
  stackDepth[0] = 0;

  for (int visit = 0; visit < MAX_DFS_VISITS_LIMIT; visit++) {
    if (visit >= u_max_dfs_visits) {
      return false;
    }
    if (stackSize <= 0) {
      return true;
    }

    stackSize -= 1;

    vec2 a = stackA[stackSize];
    vec2 b = stackB[stackSize];
    vec2 c = stackC[stackSize];
    int depth = stackDepth[stackSize];

    if (depth > u_max_dfs_depth || depth > MAX_DFS_DEPTH_LIMIT) {
      return false;
    }

    if (is_bq1_failure(b) || is_bq1_failure(c)) {
      return false;
    }

    float absb2 = c_abs2(b);
    float absc2 = c_abs2(c);
    float hBoundB = h_bound(b) + 1.0;
    float hBoundC = h_bound(c) + 1.0;
    bool inTree = (absb2 <= 9.0 && absc2 <= hBoundB * hBoundB) || (absc2 <= 9.0 && absb2 <= hBoundC * hBoundC);
    if (!inTree) {
      continue;
    }

    vec2 d = c_mul(b, c) - a;
    if (c_abs2(d) < 0.25) {
      return false;
    }

    if (stackSize + 2 > MAX_DFS_STACK) {
      return false;
    }

    stackA[stackSize] = b;
    stackB[stackSize] = c;
    stackC[stackSize] = d;
    stackDepth[stackSize] = depth + 1;
    stackSize += 1;

    stackA[stackSize] = c;
    stackB[stackSize] = b;
    stackC[stackSize] = d;
    stackDepth[stackSize] = depth + 1;
    stackSize += 1;
  }

  return stackSize <= 0;
}

bool bq_bounded(vec2 a, vec2 b, vec2 c) {
  vec2 sinkA;
  vec2 sinkB;
  vec2 sinkC;

  if (!bq_sink_to_local_minimum(a, b, c, sinkA, sinkB, sinkC)) {
    return false;
  }

  return bq_dfs_bounded(sinkA, sinkB, sinkC)
    && bq_dfs_bounded(sinkB, sinkC, sinkA)
    && bq_dfs_bounded(sinkC, sinkB, sinkA);
}

void main() {
  vec2 x = (gl_FragCoord.xy - u_resolution * 0.5) / u_scale + u_offset;
  vec2 y = u_y;

  vec2 xx = c_mul(x, x);
  vec2 yy = c_mul(y, y);
  vec2 xy = c_mul(x, y);
  vec2 discriminant = c_mul(xy, xy) - 4.0 * (xx + yy);
  vec2 z = 0.5 * (xy + c_sqrt(discriminant));

  vec3 color;

  if (u_mode == 0) {
    vec2 grid = abs(fract(x) - 0.5);
    float line = 1.0 - smoothstep(0.45, 0.5, min(grid.x, grid.y));
    color = mix(
      vec3(fract(x.x * 0.125), fract(x.y * 0.125), 0.18),
      vec3(0.92, 0.94, 0.98),
      line * 0.35
    );
  } else if (u_mode == 1) {
    color = vec3(signed_to_unit(z.x), signed_to_unit(z.y), 0.18);
  } else if (u_mode == 2) {
    color = heat(c_abs(z), 0.08);
  } else if (u_mode == 3) {
    color = heat(c_abs(discriminant), 0.015);
  } else if (u_mode == 4) {
    color = heat(h_bound(x), 0.01);
  } else {
    bool isBqLike = bq_bounded(x, y, z);
    color = isBqLike ? vec3(0.0) : vec3(1.0);
  }

  fragColor = vec4(color, 1.0);
}
