/**
 * Blurhash encoding.
 *
 * The card paints the blurhash before the hero image arrives, which is most of
 * what keeps "cold app start to first card painted" inside 2 seconds on a slow
 * connection. This is the reference algorithm: a DCT over the image reduced to
 * a few components, packed into base83.
 */

const BASE83 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encodeBase83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    out += BASE83[digit];
  }
  return out;
}

/** sRGB -> linear. */
function sRgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** linear -> sRGB, clamped to a byte. */
function linearToSRgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(c * 255 + 0.5);
}

function signPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}

function encodeDC(value: [number, number, number]): number {
  return (
    (linearToSRgb(value[0]) << 16) + (linearToSRgb(value[1]) << 8) + linearToSRgb(value[2])
  );
}

function encodeAC(value: [number, number, number], maximumValue: number): number {
  const quant = (v: number) =>
    Math.max(0, Math.min(18, Math.floor(signPow(v / maximumValue, 0.5) * 9 + 9.5)));
  return quant(value[0]) * 19 * 19 + quant(value[1]) * 19 + quant(value[2]);
}

/**
 * @param pixels RGB triples, row-major.
 * @param componentX 1..9
 * @param componentY 1..9
 */
export function encodeBlurhash(
  pixels: Uint8Array,
  width: number,
  height: number,
  componentX = 4,
  componentY = 3,
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new Error('blurhash components must be between 1 and 9');
  }

  const factors: Array<[number, number, number]> = [];
  for (let y = 0; y < componentY; y++) {
    for (let x = 0; x < componentX; x++) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const basis =
            normalisation *
            Math.cos((Math.PI * x * px) / width) *
            Math.cos((Math.PI * y * py) / height);
          const idx = 3 * px + py * 3 * width;
          r += basis * sRgbToLinear(pixels[idx] as number);
          g += basis * sRgbToLinear(pixels[idx + 1] as number);
          b += basis * sRgbToLinear(pixels[idx + 2] as number);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0] as [number, number, number];
  const ac = factors.slice(1);

  let hash = '';
  const sizeFlag = componentX - 1 + (componentY - 1) * 9;
  hash += encodeBase83(sizeFlag, 1);

  let maximumValue: number;
  if (ac.length > 0) {
    const actualMaximum = Math.max(...ac.flatMap((f) => f.map(Math.abs)));
    const quantisedMaximum = Math.max(0, Math.min(82, Math.floor(actualMaximum * 166 - 0.5)));
    maximumValue = (quantisedMaximum + 1) / 166;
    hash += encodeBase83(quantisedMaximum, 1);
  } else {
    maximumValue = 1;
    hash += encodeBase83(0, 1);
  }

  hash += encodeBase83(encodeDC(dc), 4);
  for (const factor of ac) {
    hash += encodeBase83(encodeAC(factor as [number, number, number], maximumValue), 2);
  }
  return hash;
}
