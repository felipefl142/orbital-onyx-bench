/**
 * Deterministic transcendental functions.
 *
 * `Math.sin`, `Math.exp`, `Math.pow`… are not required to be correctly rounded, and engines differ in the last bit
 * (measured: V8 and SpiderMonkey disagree on `Math.cos` for some spawn angles). Everything here uses only + − × ÷,
 * `Math.sqrt` (IEEE-754 exact) and bit manipulation, so the result is the same double on every engine.
 *
 * Algorithms and constants follow fdlibm (Sun Microsystems, freely distributable). Accuracy is within a few ulp.
 */

const buf = new DataView(new ArrayBuffer(8));

function highWord(x: number): number {
  buf.setFloat64(0, x);
  return buf.getInt32(0);
}

/** x · 2^n, exact for results in the normal range. */
export function scalbn(x: number, n: number): number {
  while (n > 1023) {
    x *= 8.98846567431158e307; // 2^1023
    n -= 1023;
    if (!Number.isFinite(x)) return x;
  }
  while (n < -1022) {
    x *= 2.2250738585072014e-308; // 2^-1022
    n += 1022;
    if (x === 0) return x;
  }
  buf.setInt32(0, (n + 1023) << 20);
  buf.setInt32(4, 0);
  return x * buf.getFloat64(0);
}

// ---------- sin / cos / tan ----------

const INVPIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** Cody-Waite reduction: x = n·π/2 + (y0 + y1). */
function remPio2(x: number): [number, number, number] {
  const n = Math.round(x * INVPIO2);
  let r = x - n * PIO2_1;
  let w = n * PIO2_1T;
  let y0 = r - w;
  // Two more refinement stages when cancellation is large (fdlibm's medium-size path).
  let t = r;
  w = n * PIO2_2;
  r = t - w;
  w = n * PIO2_2T - (t - r - w);
  y0 = r - w;
  t = r;
  w = n * PIO2_3;
  r = t - w;
  w = n * PIO2_3T - (t - r - w);
  y0 = r - w;
  const y1 = r - y0 - w;
  return [n, y0, y1];
}

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

function kSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * y));
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return kSin(x, 0);
  const [n, y0, y1] = remPio2(x);
  switch (((n % 4) + 4) % 4) {
    case 0:
      return kSin(y0, y1);
    case 1:
      return kCos(y0, y1);
    case 2:
      return -kSin(y0, y1);
    default:
      return -kCos(y0, y1);
  }
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return kCos(x, 0);
  const [n, y0, y1] = remPio2(x);
  switch (((n % 4) + 4) % 4) {
    case 0:
      return kCos(y0, y1);
    case 1:
      return -kSin(y0, y1);
    case 2:
      return -kCos(y0, y1);
    default:
      return kSin(y0, y1);
  }
}

export function tan(x: number): number {
  return sin(x) / cos(x);
}

// ---------- atan / atan2 / asin / acos ----------

const ATANHI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1, 9.09088713343650656196e-2,
  -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2, -3.65315727442169155270e-2,
  1.62858201153657823623e-2,
];

export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0 || Object.is(x, -0);
  let ax = Math.abs(x);
  if (ax >= 7.378697629483821e19) return neg ? -(ATANHI[3] + ATANLO[3]) : ATANHI[3] + ATANLO[3];
  let id: number;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x;
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      ax = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      ax = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1 / ax;
  }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return neg ? -(ax - ax * (s1 + s2)) : ax - ax * (s1 + s2);
  const r = ATANHI[id] - (ax * (s1 + s2) - ATANLO[id] - ax);
  return neg ? -r : r;
}

const PI = 3.1415926535897931160;
const PI_LO = 1.2246467991473531772e-16;
const PIO2 = 1.5707963267948965580;
const PIO4 = 7.8539816339744827900e-1;

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const yNeg = y < 0 || Object.is(y, -0);
  const xNeg = x < 0 || Object.is(x, -0);
  if (y === 0) {
    if (!xNeg) return y; // ±0
    return yNeg ? -PI : PI;
  }
  if (x === 0) return yNeg ? -PIO2 : PIO2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) {
      const r = xNeg ? 3 * PIO4 : PIO4;
      return yNeg ? -r : r;
    }
    const r = xNeg ? PI : 0;
    return yNeg ? -r : r;
  }
  if (!Number.isFinite(y)) return yNeg ? -PIO2 : PIO2;
  if (x === 1) return atan(y);
  let z: number;
  const q = Math.abs(y / x);
  if (q > 1.152921504606847e18) z = PIO2 + 0.5 * PI_LO;
  else if (xNeg && q < 8.673617379884035e-19) z = 0;
  else z = atan(q);
  if (!xNeg) return yNeg ? -z : z;
  return yNeg ? z - PI_LO - PI : PI - (z - PI_LO);
}

export function asin(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function acos(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

// ---------- exp / log ----------

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INVLN2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  if (Math.abs(x) < 3.725290298461914e-9) return 1 + x;
  const k = Math.round(x * INVLN2);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  return k === 0 ? y : scalbn(y, k);
}

const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let k = 0;
  if (x < 2.2250738585072014e-308) {
    k -= 54;
    x *= 1.8014398509481984e16; // 2^54, brings subnormals into the normal range
  }
  let hx = highWord(x);
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  // Normalize the mantissa into [sqrt(2)/2, sqrt(2)).
  buf.setFloat64(0, x);
  buf.setInt32(0, hx | (i ^ 0x3ff00000));
  const m = buf.getFloat64(0);
  k += i >> 20;
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f);
}

export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    // Exponentiation by squaring: deterministic and exact for small integer results.
    let n = Math.abs(y);
    let base = x;
    let r = 1;
    while (n > 0) {
      if (n & 1) r *= base;
      base *= base;
      n >>= 1;
    }
    return y < 0 ? 1 / r : r;
  }
  if (!Number.isFinite(y) || !Number.isFinite(x) || x === 0) return Math.pow(x, y); // special cases are exact (0, 1, ∞)
  if (x < 0) {
    if (!Number.isInteger(y)) return NaN;
    const r = exp(y * log(-x));
    return y % 2 === 0 ? r : -r;
  }
  if (x === 1) return 1;
  return exp(y * log(x));
}

export function hypot(...xs: number[]): number {
  let m = 0;
  let nan = false;
  for (const v of xs) {
    const a = Math.abs(v);
    if (a === Infinity) return Infinity;
    if (Number.isNaN(a)) nan = true;
    else if (a > m) m = a;
  }
  if (nan) return NaN;
  if (m === 0) return 0;
  let s = 0;
  for (const v of xs) {
    const r = v / m;
    s += r * r;
  }
  return m * Math.sqrt(s);
}

const LN2 = 6.93147180559945286227e-1;
const LN10 = 2.30258509299404590109;

export const log2 = (x: number) => log(x) / LN2;
export const log10 = (x: number) => log(x) / LN10;
export const log1p = (x: number) => (Math.abs(x) < 1e-5 ? x - (x * x) / 2 + (x * x * x) / 3 : log(1 + x));
export const expm1 = (x: number) => (Math.abs(x) < 1e-5 ? x + (x * x) / 2 + (x * x * x) / 6 : exp(x) - 1);
export const sinh = (x: number) => (Math.abs(x) < 1e-5 ? x : (exp(x) - exp(-x)) / 2);
export const cosh = (x: number) => (exp(x) + exp(-x)) / 2;
export const tanh = (x: number) => {
  if (x > 20) return 1;
  if (x < -20) return -1;
  if (Math.abs(x) < 1e-5) return x;
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
};
export const asinh = (x: number): number => (x < 0 ? -asinh(-x) : log(x + Math.sqrt(x * x + 1)));
export const acosh = (x: number) => (x < 1 ? NaN : log(x + Math.sqrt(x * x - 1)));
export const atanh = (x: number) => 0.5 * log((1 + x) / (1 - x));
export const cbrt = (x: number) => {
  if (x === 0 || !Number.isFinite(x)) return x;
  const a = Math.abs(x);
  let y = exp(log(a) / 3);
  y -= (y * y * y - a) / (3 * y * y);
  return x < 0 ? -y : y;
};

/** Every Math function whose result is not pinned down by IEEE-754, replaced by the deterministic version. */
export const DETERMINISTIC_MATH = {
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  exp,
  log,
  pow,
  hypot,
  log2,
  log10,
  log1p,
  expm1,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  cbrt,
};
