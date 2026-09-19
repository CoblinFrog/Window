import { hashString, mulberry32 } from '@window/shared';
import type { RgbImage } from './png.js';

/**
 * Deterministic product imagery.
 *
 * The synthetic catalog has no source photographs to transcode, so the media
 * pipeline generates them: a lit object on a studio backdrop, with the palette
 * and silhouette derived from the product's media key. It is deliberately
 * abstract — the point is that every card has real, distinct, colour-varied
 * raster bytes at the right dimensions, so the feed exercises image decode,
 * prefetch, eviction and the scrim's contrast behaviour honestly.
 *
 * Everything is a pure function of the key, so the same key always renders the
 * same image at any width and nothing needs to be stored.
 */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

type Silhouette = 'capsule' | 'circle' | 'rounded' | 'tall' | 'wide';
const SILHOUETTES: Silhouette[] = ['capsule', 'circle', 'rounded', 'tall', 'wide'];

interface Palette {
  backdropTop: [number, number, number];
  backdropBottom: [number, number, number];
  objectLight: [number, number, number];
  objectDark: [number, number, number];
  silhouette: Silhouette;
  objectScale: number;
  lightAngle: number;
}

export function paletteFor(key: string): Palette {
  const random = mulberry32(hashString(key));
  const objectHue = Math.floor(random() * 360);
  // A backdrop that is close to, but not the same as, the object's hue reads as
  // a styled set rather than a clip-art cutout.
  const backdropHue = (objectHue + 150 + Math.floor(random() * 60)) % 360;
  const backdropSat = 0.08 + random() * 0.22;
  const backdropLight = 0.14 + random() * 0.24;
  const objectSat = 0.35 + random() * 0.45;
  const objectLight = 0.42 + random() * 0.2;

  return {
    backdropTop: hslToRgb(backdropHue, backdropSat, backdropLight + 0.1),
    backdropBottom: hslToRgb(backdropHue, backdropSat, Math.max(0.05, backdropLight - 0.08)),
    objectLight: hslToRgb(objectHue, objectSat, Math.min(0.85, objectLight + 0.22)),
    objectDark: hslToRgb(objectHue, objectSat, Math.max(0.08, objectLight - 0.24)),
    silhouette: SILHOUETTES[Math.floor(random() * SILHOUETTES.length)] as Silhouette,
    objectScale: 0.46 + random() * 0.22,
    lightAngle: random() * Math.PI * 2,
  };
}

/** Signed distance from `(x, y)` to the object's surface, in normalized units. */
function silhouetteDistance(
  shape: Silhouette,
  nx: number,
  ny: number,
  halfWidth: number,
  halfHeight: number,
): number {
  switch (shape) {
    case 'circle': {
      const r = Math.min(halfWidth, halfHeight);
      return Math.hypot(nx, ny) - r;
    }
    case 'capsule': {
      const r = halfWidth * 0.55;
      const straight = Math.max(0, halfHeight - r);
      const dy = Math.max(0, Math.abs(ny) - straight);
      return Math.hypot(nx, dy) - r;
    }
    case 'tall':
    case 'wide':
    case 'rounded': {
      const radius = Math.min(halfWidth, halfHeight) * 0.28;
      const dx = Math.abs(nx) - (halfWidth - radius);
      const dy = Math.abs(ny) - (halfHeight - radius);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.min(Math.max(dx, dy), 0);
      return outside + inside - radius;
    }
  }
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Renders at any size. Anti-aliasing comes from the signed distance field being
 * feathered across roughly one pixel, so a 32 px thumbnail and a 1440 px hero
 * are the same image rather than one being a blocky version of the other.
 */
export function renderProductImage(key: string, width: number, height: number): RgbImage {
  const palette = paletteFor(key);
  const pixels = new Uint8Array(width * height * 3);

  const aspect = width / height;
  let halfWidth = palette.objectScale;
  let halfHeight = palette.objectScale;
  if (palette.silhouette === 'tall') halfWidth *= 0.62;
  if (palette.silhouette === 'wide') halfHeight *= 0.6;
  if (palette.silhouette === 'capsule') halfWidth *= 0.72;

  const feather = 2 / Math.min(width, height);
  const lightX = Math.cos(palette.lightAngle) * 0.6;
  const lightY = Math.sin(palette.lightAngle) * 0.6;

  // The object sits slightly above centre, which is where product photography
  // puts it to leave room for the shadow.
  const objectCenterY = -0.06;

  let offset = 0;
  for (let py = 0; py < height; py++) {
    // Normalized coordinates, y down, scaled so the short edge spans [-1, 1].
    const ny = ((py + 0.5) / height) * 2 - 1;
    for (let px = 0; px < width; px++) {
      const nx = (((px + 0.5) / width) * 2 - 1) * (aspect >= 1 ? aspect : 1);
      const nyAdj = ny / (aspect < 1 ? aspect : 1);

      // Backdrop: a vertical gradient with a soft radial lift behind the object.
      const verticalT = (nyAdj + 1) / 2;
      let color = mix(palette.backdropTop, palette.backdropBottom, verticalT);
      const halo = Math.max(0, 1 - Math.hypot(nx, nyAdj - objectCenterY) / 1.35);
      color = mix(color, palette.objectDark, halo * 0.18);

      // Contact shadow beneath the object.
      const shadowY = (nyAdj - (objectCenterY + halfHeight * 0.92)) / (halfHeight * 0.3);
      const shadowX = nx / (halfWidth * 1.15);
      const shadow = Math.max(0, 1 - Math.hypot(shadowX, shadowY));
      color = mix(color, [0, 0, 0], shadow * 0.5);

      // The object itself.
      const distance = silhouetteDistance(
        palette.silhouette,
        nx,
        nyAdj - objectCenterY,
        halfWidth,
        halfHeight,
      );
      if (distance < feather) {
        const coverage = distance <= -feather ? 1 : (feather - distance) / (2 * feather);
        // Lambert-ish shading from the surface normal implied by the gradient.
        const shade = 0.5 + 0.5 * (nx * lightX + (nyAdj - objectCenterY) * -lightY);
        let surface = mix(palette.objectDark, palette.objectLight, Math.max(0, Math.min(1, shade)));
        // A specular highlight where the light is strongest.
        const specular = Math.max(
          0,
          1 - Math.hypot(nx - lightX * halfWidth, nyAdj - objectCenterY + lightY * halfHeight) / (halfWidth * 0.5),
        );
        surface = mix(surface, [255, 255, 255], specular ** 3 * 0.55);
        color = mix(color, surface, coverage);
      }

      // Vignette, so the scrim always has something to sit against.
      const vignette = 1 - 0.22 * Math.min(1, Math.hypot(nx, nyAdj) / 1.5) ** 2;
      pixels[offset++] = Math.max(0, Math.min(255, Math.round(color[0] * vignette)));
      pixels[offset++] = Math.max(0, Math.min(255, Math.round(color[1] * vignette)));
      pixels[offset++] = Math.max(0, Math.min(255, Math.round(color[2] * vignette)));
    }
  }

  return { width, height, pixels };
}
