/**
 * Exact OKLab (Björn Ottosson) color conversions for the NPR palette stage
 * (P2-T2). Pure f64 math over sRGB bytes and linear/OKLab reals — no GPU, no
 * image IO. OKLab is the perceptual space the skill mandates for quantization:
 * match colors here, never in RGB (npr-sprite-stylization).
 *
 * Reference: https://bottosson.github.io/posts/oklab/ (public-domain snippet).
 * The forward and inverse 3x3 matrices are exact inverses of each other; the
 * round-trip tests pin srgb -> lab -> srgb to within +/-1 code value across a
 * full color sweep, and every grey code round-trips exactly.
 */
/** An OKLab triple (L, a, b). Owned here since the move from @spritebook/style:
 * the maths and its type travel together, and style re-exports for its callers. */
export type Lab = readonly [number, number, number];

/** sRGB EOTF: 8-bit code value (0..255) -> linear light (0..1). */
export function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * Inverse sRGB EOTF: linear light -> 8-bit code value, rounded and clamped to
 * 0..255. Values <= 0.0031308 (incl. slightly negative round-trip noise) take
 * the linear branch, so the power is never evaluated on a negative base.
 */
export function linearToSrgb(x: number): number {
  const v = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  const c = Math.round(v * 255);
  return c < 0 ? 0 : c > 255 ? 255 : c;
}

/** Linear sRGB (0..1) -> OKLab. Ottosson's LMS matrix + cube-root nonlinearity. */
export function linearToOklab(r: number, g: number, b: number): Lab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

/** sRGB bytes (0..255) -> OKLab. */
export function srgbToLab(r: number, g: number, b: number): Lab {
  return linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

/**
 * OKLab -> sRGB bytes (0..255), gamut-clamped per channel. Inverse of srgbToLab
 * (Ottosson's inverse matrices; the cube undoes the forward cube-root).
 */
export function oklabToSrgb(lab: Lab): [number, number, number] {
  const [r, g, b] = oklabToLinearRgb(lab);
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

/**
 * OKLab -> LINEAR rgb, UNCLAMPED. Values outside [0, 1] mean the colour sits
 * outside the sRGB gamut — which is exactly what gen's colour-match pass needs
 * to MEASURE (its gamut-clip metric): `oklabToSrgb` clamps silently, and a
 * clipped texel silently loses chroma, which is the pastel-washout failure.
 */
export function oklabToLinearRgb(lab: Lab): [number, number, number] {
  const [L, a, b] = lab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function clampByte(n: number): number {
  const v = Math.round(n);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function byteToHex(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

/** sRGB bytes -> '#rrggbb'. Inputs are rounded and clamped to bytes first. */
export function srgbToHex(r: number, g: number, b: number): string {
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

/** OKLab -> '#rrggbb' (via oklabToSrgb). */
export function labToHex(lab: Lab): string {
  const [r, g, b] = oklabToSrgb(lab);
  return srgbToHex(r, g, b);
}
