/**
 * The visual system.
 *
 * Monochrome frame, chromatic content: the entire UI is black, white and one
 * accent, and all colour comes from the products. Everything here is
 * load-bearing for that, so additions should be resisted rather than welcomed.
 */

export const COLORS = {
  /** True black, so product media appears to float. */
  surface: '#000000',
  surfaceLight: '#FFFFFF',
  /** The one accent. Used only for upvote-active, price emphasis and focus rings. */
  accent: '#FF3B5C',
  textPrimary: '#FFFFFF',
  textPrimaryLight: '#000000',
  /** Secondary text over media, always on a scrim. */
  textSecondary: 'rgba(255,255,255,0.72)',
  textSecondaryLight: 'rgba(0,0,0,0.64)',
  /** Hairline separators. There are no borders elsewhere. */
  hairline: 'rgba(255,255,255,0.14)',
  hairlineLight: 'rgba(0,0,0,0.12)',
  /** Sheet backgrounds sit above the feed, never over another sheet. */
  sheet: '#0A0A0A',
  sheetLight: '#FAFAFA',
  /** Backdrop behind the centred column on desktop. */
  backdrop: '#0A0A0A',

  // The window screen inverts the frame: white cards on true black, so the
  // product photography reads as lit rather than as floating. These three are
  // the only chromatic tokens in the system and each carries a signal a
  // monochrome treatment cannot.
  /** Card body behind a tile's image and caption. */
  card: '#FFFFFF',
  /** Rating stars. Warm, because a grey star reads as unrated. */
  star: '#F5A623',
  /** Review counts, which are a way into the reviews sheet. */
  link: '#2F6FED',
} as const;

/**
 * The only way to hit WCAG AA over arbitrary product photography:
 * a vertical gradient over the bottom 35% and a horizontal one over the right 20%.
 */
export const SCRIM = {
  bottomFraction: 0.35,
  rightFraction: 0.22,
  /** The pane view's back control sits here. */
  topFraction: 0.16,
  bottomStops: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.78)'] as const,
  rightStops: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.42)'] as const,
  topStops: ['rgba(0,0,0,0.42)', 'rgba(0,0,0,0)'] as const,
} as const;

/** Sharp edges read as glass; rounded cards read as apps. */
/**
 * The pane view's glass is a rounded panel laid on the black, and the window
 * screen is explicitly card-shaped: four separate things you are choosing
 * between, not four panes of one sheet.
 */
export const RADIUS = {
  media: 18,
  tile: 18,
  /** The image inside a tile, inset from the card by the tile's padding. */
  tileImage: 14,
} as const;

export const SPACING = {
  /** The grid should read as panes of one window, not four separate cards. */
  gutter: 2,
  /** Screen margin for text. */
  screenMargin: 16,
  railRightInset: 20,
  railItemGap: 20,
} as const;

/** One typeface, three sizes, two weights. */
export const TYPE = {
  sizes: { small: 13, body: 15, title: 17, subhead: 19, price: 20, display: 30, hero: 34 },
  weights: { regular: '400', semibold: '600', bold: '700' },
  lineHeights: { small: 17, body: 20, title: 22, subhead: 25, price: 24, display: 36, hero: 40 },
} as const;

/**
 * The window screen.
 *
 * Two columns of cards, four products to a pane. Two things vary per tile and
 * the difference between them matters:
 *
 *   - The **image height** comes from the source photograph. Width is fixed at
 *     the column width, height is whatever that photograph's aspect ratio makes
 *     it. The image is the only element allowed to change size, because it is
 *     the only element carrying information about the product.
 *   - The **padding, gaps and column drop** are hashed from the product id.
 *     They are arbitrary on purpose: a grid whose tiles line up into rows reads
 *     as a ranked list, and this feed's whole claim is that it is not one.
 *
 * Every value here is a band. Nothing is a fixed size except the column width,
 * which is fixed precisely so the aspect ratio is the only thing changing the
 * image's height.
 */
export const WINDOW = {
  /** Outer margin either side of the two columns. */
  screenPad: 10,
  /** Between the two columns. */
  columnGap: 12,
  /**
   * Card padding: the white mount around a tile's image. Kept thin — the
   * photograph is the point of the tile and the card is only what it is
   * mounted on.
   */
  padMin: 4,
  padMax: 10,
  /** Vertical gap between the two cards in a column. */
  rowGapMin: 16,
  rowGapMax: 40,
  /** The right column hangs below the left by this fraction of the viewport. */
  dropMin: 0.05,
  dropMax: 0.15,
  /** A small drop on the left too, so neither column reads as the anchor. */
  leftDropMax: 0.04,
  /**
   * Source aspect ratios (height ÷ width) are clamped into this band. A 3:1
   * banner and a 1:4 tower are both real product photography and neither gets
   * to decide how tall an entire pane is.
   */
  aspectMin: 0.7,
  aspectMax: 1.55,
  /** Used when a source image never reported its dimensions. */
  aspectFallback: 1,
  /** Images shrink no further than this when a pane has to fit the viewport. */
  minFitScale: 0.55,
  /**
   * Centring a short pane. An image's height is its own photograph's, never
   * the viewport's, so on a tall phone four honest tiles routinely come up
   * short. The slack becomes margin around the whole group rather than space
   * between the tiles — stretching a photograph to fill a screen is exactly
   * the lie the aspect-ratio rule exists to prevent, and pushing the tiles
   * apart would turn a pane into four things that merely share a screen.
   * This much of the leftover goes above, the rest below.
   */
  groupTopShare: 0.46,
} as const;

/**
 * The settle: a pane arriving stretches and springs back.
 *
 * It plays on arrival, not during travel — the travelling already happened
 * under the finger — and it leans the way the surface was moving, so a
 * backwards scroll does not settle forwards.
 */
export const STRETCH = {
  /** Peak vertical scale. Past about 1.06 the text visibly distorts. */
  scale: 1.05,
  /** Peak lift, in px, signed by the direction of travel. */
  lift: 9,
  upMs: 110,
  /** The return is a spring, so tiles overshoot and settle rather than stop dead. */
  settleDamping: 11,
  settleStiffness: 190,
  settleMass: 0.55,
  /** Per-tile stagger, in reading order. */
  staggerMs: 34,
} as const;

/**
 * Scrolling. Both feeds are continuous surfaces snapped to page boundaries:
 * a drag moves them with the finger and the neighbours come into view behind,
 * and letting go settles onto whichever page the gesture was heading for.
 */
export const SCROLL = {
  /** Past this fraction of a page, letting go advances rather than returns. */
  advanceFraction: 0.18,
  /** ...as does a flick this fast, provided it actually went somewhere. */
  flickVelocity: 520,
  /** A flick under this many pixels is the jitter at the end of a tap. */
  flickMinTravel: 8,
  /** How long a release takes to settle onto its page. */
  settleMs: 260,
  /** Drag resistance past the first page and past the last loaded one. */
  edgeResistance: 0.28,
  /** Movement before the scroll takes the gesture from a tap. */
  activationSlop: 12,
} as const;

/**
 * Stepping closer to the glass: the tile-to-pane zoom.
 *
 * The pane grows out of the tile's own rectangle, which means matching a
 * tile's proportions to the screen's — and those never agree. A uniform scale
 * cannot: it lands the pane near the tile rather than on it. The two axes are
 * scaled independently instead, and the brief squash costs nothing because the
 * pane is still nearly transparent while it is most distorted.
 *
 * The grid does not zoom with it. It leans, anchored on the tapped tile so
 * that tile alone stays still, and fades. Scaling the grid all the way up to
 * meet the pane throws the other three tiles off screen in a few frames, which
 * reads as a glitch rather than as a zoom.
 */
export const ZOOM = {
  /** How far the grid expands, with the tapped tile as the fixed point. */
  gridLean: 1.08,
  /** The grid is gone by this fraction of the transition. */
  gridFadeBy: 0.55,
  /** The pane is fully opaque by this fraction. */
  paneFadeBy: 0.38,
} as const;

export const ICON = {
  glyph: 24,
  /** 56 px target; the accessibility floor is 44 px and this clears it. */
  target: 56,
  minTarget: 44,
  strokeWidth: 1.75,
} as const;

/** Depth comes from the scrim and from scale. There are no shadows. */
export const ELEVATION = { none: 0 } as const;

/**
 * Motion explains space, never entertains. Every transition is under 250 ms and
 * `prefers-reduced-motion` replaces them with cuts.
 */
export const MOTION = {
  promoteMs: 220,
  modeSwitchMs: 200,
  sheetMs: 240,
  upvoteBurstMs: 180,
  maxMs: 250,
  /** Standard easing; nothing bounces, nothing celebrates. */
  easing: [0.22, 0.61, 0.36, 1] as const,
} as const;

/** Responsive rules. Over 1600 px the extra space stays empty. */
export const BREAKPOINTS = {
  phone: 480,
  tablet: 1024,
  wide: 1600,
  /** The feed column never grows past this. */
  columnMaxWidth: 480,
  columnAspect: 9 / 16,
} as const;

/** Reviews sheet opens to 70% height. */
export const SHEET = {
  reviewsHeightFraction: 0.7,
  sellerHeightFraction: 0.7,
  /** A skeleton appears if content has not arrived by this point. */
  skeletonAfterMs: 150,
} as const;

/** Desktop keyboard bindings. */
export const KEYBINDINGS = {
  nextCard: ['ArrowDown'],
  prevCard: ['ArrowUp'],
  modeLeft: ['ArrowLeft'],
  modeRight: ['ArrowRight'],
  upvote: ['l', 'L'],
  reviews: ['c', 'C'],
  cart: ['b', 'B'],
  playPause: [' '],
  closeSheet: ['Escape'],
} as const;
