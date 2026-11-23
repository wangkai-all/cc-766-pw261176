// 确定性随机数与分布工具（无外部依赖；浏览器/Node 通用）

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32：确定性 PRNG
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal via Box–Muller
export function makeGaussian(rng) {
  let spare = null;
  return function gaussian() {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

// Beta 分布：Johnk（a,b<1）或 Marsaglia 伽马比值法
function gammaSample(rng, shape) {
  if (shape < 1) {
    // Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return gammaSample(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  const gauss = makeGaussian(rng);
  for (;;) {
    let x;
    let v;
    do {
      x = gauss();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(rng, a, b) {
  const x = gammaSample(rng, a);
  const y = gammaSample(rng, b);
  return x / (x + y);
}

export function binomial(rng, n, p) {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
