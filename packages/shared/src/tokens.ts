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
} as const;

/**
 * The only way to hit WCAG AA over arbitrary product photography:
 * a vertical gradient over the bottom 35% and a horizontal one over the right 20%.
 */
export const SCRIM = {
  bottomFraction: 0.35,
  rightFraction: 0.2,
  bottomStops: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.78)'] as const,
  rightStops: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.45)'] as const,
} as const;

/** Sharp edges read as glass; rounded cards read as apps. */
export const RADIUS = {
  media: 0,
  tile: 2,
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
  sizes: { small: 13, body: 15, price: 20 },
  weights: { regular: '400', semibold: '600' },
  lineHeights: { small: 17, body: 20, price: 24 },
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
