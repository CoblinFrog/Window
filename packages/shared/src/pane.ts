/**
 * The window screen's layout.
 *
 * Four products, two columns, one pane. Two things vary from tile to tile and
 * the difference between them matters:
 *
 *   - The **image height** comes from the source photograph. Width is fixed at
 *     the column width; height is whatever that photograph's own aspect ratio
 *     makes it. The image is the only element allowed to change size, because
 *     it is the only element carrying information about the product.
 *   - The **padding, gaps and column drop** come from a hash of the product id.
 *     They are arbitrary on purpose: a grid whose tiles line up into rows reads
 *     as a ranked list, and this feed's whole claim is that it is not one.
 *
 * Hashing the id rather than calling a random number generator is what makes
 * the layout stable. The same four products laid out twice — a re-render, a
 * return from the pane view, a remembered pane — produce the identical grid. A
 * live `Math.random()` here would reshuffle the whole screen on every render.
 *
 * Kept pure, and kept here rather than in the app, so it can be tested without
 * a renderer.
 */

import { TYPE, WINDOW } from './tokens.js';

export interface PaneTileSource {
  id: string;
  /** Source image dimensions. Zero or missing falls back to a square. */
  imageWidth: number;
  imageHeight: number;
  /** Only used to estimate the caption's height when fitting a pane. */
  title: string;
}

export interface TilePlan {
  id: string;
  /** 0 is the left column, 1 the right. */
  column: 0 | 1;
  /** Position within the column, top first. */
  row: number;
  /** Reading order across the pane, which is what the settle staggers on. */
  order: number;
  /** The white mount around the image. Hashed, within the token band. */
  pad: number;
  imageWidth: number;
  imageHeight: number;
  /** Gap below this card, within its column. Hashed. Zero on the last card. */
  gapBelow: number;
}

export interface PanePlan {
  columnWidth: number;
  /** Top offset of each column, in px. The right one always hangs lower. */
  drops: [number, number];
  tiles: TilePlan[];
  /**
   * Factor applied to every image height to make the taller column fit. 1 when
   * the pane already fits, which is the common case.
   */
  fitScale: number;
}

/**
 * A 32-bit FNV-1a with a final avalanche, salted so one id yields several
 * independent streams. Not a cryptographic hash and does not need to be: it
 * needs to be stable across renders and well-spread across ids, and it is.
 */
export function hashUnit(id: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Height ÷ width of the source photograph, clamped into the token band. A 3:1
 * banner and a 1:4 tower are both real product photography, and neither gets
 * to decide how tall an entire pane is.
 */
export function aspectOf(source: Pick<PaneTileSource, 'imageWidth' | 'imageHeight'>): number {
  const { imageWidth, imageHeight } = source;
  if (!(imageWidth > 0) || !(imageHeight > 0)) return WINDOW.aspectFallback;
  return clamp(imageHeight / imageWidth, WINDOW.aspectMin, WINDOW.aspectMax);
}

/**
 * The flap beneath the photograph.
 *
 * Deliberately cramped. The tile's job is to show a product, and every point
 * spent on space around its name is a point taken off the photograph — which
 * in a grid of four is the only thing anyone is actually comparing. These are
 * the exact values the tile renders with, exported so the estimate below and
 * the drawn flap cannot drift apart.
 */
const CAPTION_ABOVE = 5;
const CAPTION_BETWEEN = 1;
const CAPTION_BELOW = 2;
const RATING_ROW = 18;
export const CAPTION_MAX_LINES = 3;

export const CAPTION_SPACING = {
  above: CAPTION_ABOVE,
  between: CAPTION_BETWEEN,
  below: CAPTION_BELOW,
  ratingRow: RATING_ROW,
} as const;

/** Roughly 0.44em per character at the caption's weight and size. */
const CAPTION_CHAR_WIDTH = TYPE.sizes.body * 0.44;

/**
 * The caption's height, estimated rather than measured.
 *
 * Only the fit calculation uses it. The cards themselves are laid out by flex
 * and size to their real content, so an estimate that is a line out makes the
 * pane slightly taller or shorter than planned — it can never make two cards
 * overlap, which is the failure mode worth designing against.
 */
export function captionHeight(title: string, contentWidth: number): number {
  const perLine = Math.max(8, Math.floor(contentWidth / CAPTION_CHAR_WIDTH));
  const lines = clamp(Math.ceil(title.length / perLine), 1, CAPTION_MAX_LINES);
  return (
    CAPTION_ABOVE + lines * TYPE.lineHeights.body + CAPTION_BETWEEN + RATING_ROW + CAPTION_BELOW
  );
}

/**
 * Lays out one pane.
 *
 * Reading order fills across before down — 0 and 2 on the left, 1 and 3 on the
 * right — so a pane scanned left-to-right, top-to-bottom is read in ranked
 * order despite the columns being offset from each other.
 */
export function planPane(
  sources: readonly PaneTileSource[],
  viewport: { width: number; height: number },
): PanePlan {
  const columnWidth = (viewport.width - WINDOW.screenPad * 2 - WINDOW.columnGap) / 2;

  const tiles: TilePlan[] = sources.map((source, order) => {
    const column: 0 | 1 = (order % 2) as 0 | 1;
    const pad = Math.round(lerp(WINDOW.padMin, WINDOW.padMax, hashUnit(source.id, 1)));
    const imageWidth = columnWidth - pad * 2;

    return {
      id: source.id,
      column,
      row: Math.floor(order / 2),
      order,
      pad,
      imageWidth,
      imageHeight: imageWidth * aspectOf(source),
      // The last card in a column has nothing below it to be spaced from.
      gapBelow:
        order + 2 < sources.length
          ? Math.round(lerp(WINDOW.rowGapMin, WINDOW.rowGapMax, hashUnit(source.id, 2)))
          : 0,
    };
  });

  // The drop is what breaks the two columns out of alignment. It is hashed off
  // the pane's first product, so a given pane always hangs the same way.
  const seed = sources[0]?.id ?? '';
  const drops: [number, number] = [
    Math.round(viewport.height * lerp(0, WINDOW.leftDropMax, hashUnit(seed, 3))),
    Math.round(viewport.height * lerp(WINDOW.dropMin, WINDOW.dropMax, hashUnit(seed, 4))),
  ];

  /** The scale images must take for both columns to fit `viewport.height`. */
  const requiredScale = (withDrops: readonly [number, number]): number => {
    let worst = Infinity;

    for (const column of [0, 1] as const) {
      const inColumn = tiles.filter((tile) => tile.column === column);
      if (inColumn.length === 0) continue;

      // Everything that does not scale: the drop, the white padding, the
      // captions and the gaps between cards.
      const fixed = inColumn.reduce(
        (total, tile) =>
          total +
          tile.pad * 2 +
          captionHeight(sources[tile.order]?.title ?? '', tile.imageWidth) +
          tile.gapBelow,
        withDrops[column],
      );
      const images = inColumn.reduce((total, tile) => total + tile.imageHeight, 0);
      if (images <= 0) continue;

      worst = Math.min(worst, (viewport.height - fixed) / images);
    }

    return Number.isFinite(worst) ? worst : 1;
  };

  let fitScale = requiredScale(drops);

  if (fitScale < 1) {
    // Shrinking the images alone would hit the floor while a sixth of the
    // viewport sits unused above the right column. The drop gives way first,
    // because it is decoration and the photograph is not.
    drops[0] = Math.round(drops[0] * Math.max(fitScale, 0));
    drops[1] = Math.round(drops[1] * Math.max(fitScale, 0));
    fitScale = requiredScale(drops);
  }

  fitScale = clamp(fitScale, WINDOW.minFitScale, 1);
  const scaled = tiles.map((tile) => ({ ...tile, imageHeight: tile.imageHeight * fitScale }));

  // ---- Centring a short pane ------------------------------------------------
  // Everything above shrinks a pane that is too tall. This centres one that is
  // too short, which on a tall phone is the common case: four photographs at
  // their own aspect ratios have no reason to add up to the height of a screen.
  // Both columns move by the same amount, so the drop that offsets them
  // survives intact and the four tiles stay clustered.
  const extentOf = (column: 0 | 1): number =>
    scaled
      .filter((tile) => tile.column === column)
      .reduce(
        (total, tile) =>
          total +
          tile.pad * 2 +
          tile.imageHeight +
          captionHeight(sources[tile.order]?.title ?? '', tile.imageWidth) +
          tile.gapBelow,
        drops[column],
      );

  const slack = viewport.height - Math.max(extentOf(0), extentOf(1));
  if (slack > 0) {
    const above = Math.round(slack * WINDOW.groupTopShare);
    drops[0] += above;
    drops[1] += above;
  }

  return { columnWidth, drops, tiles: scaled, fitScale };
}

/**
 * Delay before a tile joins the settle, by reading order. The pane ripples in
 * the direction the eye already travels.
 */
export function stretchDelay(order: number, staggerMs: number): number {
  return order * staggerMs;
}
