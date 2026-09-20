import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { COLORS, ICON } from '@window/shared';

/**
 * Icons.
 *
 * Single-weight outline, filled only when active. A 24 px glyph in a 56 px
 * target. There is no second weight and no second size, because an icon set
 * that grows is how a monochrome frame turns into decoration.
 */

export type IconName =
  | 'upvote'
  | 'chevronDown'
  | 'star'
  | 'reviews'
  | 'cart'
  | 'cartAdd'
  | 'share'
  | 'seller'
  | 'close'
  | 'back'
  | 'check'
  | 'grid'
  | 'single'
  | 'warning'
  | 'search'
  | 'link';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  /** Filled rather than outlined. The only state an icon has. */
  active?: boolean;
  activeColor?: string;
}

export function Icon({
  name,
  size = ICON.glyph,
  color = COLORS.textPrimary,
  active = false,
  activeColor = COLORS.accent,
}: IconProps): React.ReactElement {
  const stroke = active ? activeColor : color;
  const fill = active ? activeColor : 'none';

  const common = {
    stroke,
    strokeWidth: ICON.strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill,
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {renderGlyph(name, common, stroke)}
    </Svg>
  );
}

function renderGlyph(
  name: IconName,
  common: {
    stroke: string;
    strokeWidth: number;
    strokeLinecap: 'round';
    strokeLinejoin: 'round';
    fill: string;
  },
  stroke: string,
  // `JSX.Element`, not `ReactElement`. React 19's types made the latter
  // generic over `unknown` rather than `any`, and a `ReactElement<unknown>`
  // is no longer assignable to `ReactNode` — which is what this is used as,
  // one line below, as the child of an `Svg`.
): React.JSX.Element {
  switch (name) {
    // A thumb rather than a heart: this is a judgement about a product, not an
    // emotion about a post. It is the most heavily weighted explicit signal in
    // the ranking model, so it gets the most legible glyph in the set.
    case 'upvote':
      return (
        <>
          <Path
            d="M7 10.5 11 3a2.2 2.2 0 0 1 2.2 2.2V9h4.4a2 2 0 0 1 2 2.35l-1.2 6.4A2.4 2.4 0 0 1 16 19.7H7"
            {...common}
          />
          <Path d="M7 10.5v9.2H4.6a1 1 0 0 1-1-1v-7.2a1 1 0 0 1 1-1H7Z" {...common} />
        </>
      );

    // A star inside a speech bubble: reviews are other people's verdicts, which
    // is a different thing from a comment thread and should not look like one.
    //
    // The star is solid while the bubble is outlined, which breaks the set's
    // one rule on purpose. A five-point star drawn as an outline has two stroke
    // walls and a hairline of gap between them at every one of its ten
    // vertices; at the size this is actually rendered that gap closes and the
    // star fills in unevenly, reading as a smudge rather than a star. Solid, it
    // survives. It is also the only glyph in the set nested inside another, so
    // it is the only one where the two weights can be told apart.
    case 'reviews':
      return (
        <>
          <Path
            d="M5.4 4h13.2a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-5l-2.3 3.6-1.9-3.6H5.4A2.4 2.4 0 0 1 3 13.6V6.4A2.4 2.4 0 0 1 5.4 4Z"
            {...common}
            fill="none"
          />
          <Path
            d="M12 5.8 13.05 8.56 15.99 8.7 13.69 10.55 14.47 13.4 12 11.78 9.53 13.4 10.31 10.55 8.01 8.7 10.95 8.56Z"
            fill={stroke}
            stroke="none"
          />
        </>
      );

    case 'cart':
      return (
        <>
          <Path d="M2.6 4h2.5l2.6 10.4h9.6l2.1-7.6H6.3" {...common} fill="none" />
          <Circle cx={9} cy={19} r={1.6} {...common} />
          <Circle cx={16.6} cy={19} r={1.6} {...common} />
        </>
      );

    // The same cart with a plus in the basket. The bar's cart control is not a
    // way to the cart — that is the button on the window screen — it is the
    // act of putting this product in one, and the two should not look alike.
    // The basket is shortened to make room rather than the plus hung off the
    // side, where at this size it reads as a smudge next to the glyph.
    case 'cartAdd':
      return (
        <>
          <Path d="M2.6 4h2.5l2.6 10.4h9.6l1.2-4.3" {...common} fill="none" />
          <Path d="M6.3 6.8h6.4" {...common} fill="none" />
          <Circle cx={9} cy={19} r={1.6} {...common} />
          <Circle cx={16.6} cy={19} r={1.6} {...common} />
          <Path d="M18 3.4v5M15.5 5.9h5" {...common} fill="none" />
        </>
      );

    // A curved arrow leaving the frame rather than a tray with an arrow in it:
    // sharing sends a link out, it does not export anything.
    case 'share':
      return (
        <>
          <Path d="M3 18.5c1.8-6.4 6.4-9.6 13.8-9.6" {...common} fill="none" />
          <Path d="m13.2 4.4 7 4.5-7 4.5" {...common} fill="none" />
        </>
      );

    /** The affordance on a rating: it points at the reviews. */
    case 'chevronDown':
      return <Path d="m5 9 7 7 7-7" {...common} fill="none" />;

    case 'star':
      return (
        <Path
          d="M12 3.2l2.7 5.6 6 .85-4.35 4.3 1.05 6.05L12 17.14 6.6 20l1.05-6.05L3.3 9.65l6-.85L12 3.2Z"
          {...common}
        />
      );

    case 'seller':
      return (
        <>
          <Circle cx={12} cy={8} r={4} {...common} />
          <Path d="M4 21a8 8 0 0 1 16 0" {...common} fill="none" />
        </>
      );

    case 'close':
      return <Path d="M6 6l12 12M18 6L6 18" {...common} fill="none" />;

    case 'back':
      return <Path d="M15 5l-7 7 7 7" {...common} fill="none" />;

    case 'check':
      return <Path d="M4 12.5l5.5 5.5L20 7" {...common} fill="none" />;

    // The mode toggle mirrors the layouts themselves: four panes, or one.
    case 'grid':
      return (
        <>
          <Rect x={3} y={3} width={8} height={8} {...common} />
          <Rect x={13} y={3} width={8} height={8} {...common} />
          <Rect x={3} y={13} width={8} height={8} {...common} />
          <Rect x={13} y={13} width={8} height={8} {...common} />
        </>
      );

    case 'single':
      return <Rect x={4} y={3} width={16} height={18} rx={0} {...common} />;

    case 'warning':
      return (
        <>
          <Path d="M12 3 2 20h20L12 3Z" {...common} fill="none" />
          <Path d="M12 9v5" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
          <Circle cx={12} cy={17} r={1} fill={stroke} />
        </>
      );

    // The assistant's affordance. A magnifier rather than a chat bubble: what
    // it opens is a way to ask for a thing, and "reviews" already owns the
    // bubble in this set.
    case 'search':
      return (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} {...common} fill="none" />
          <Path d="M15.4 15.4 20.5 20.5" {...common} fill="none" />
        </>
      );

    case 'link':
      return (
        <>
          <Path d="M10 14a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 5.34l-1.5 1.5" {...common} fill="none" />
          <Path d="M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1.5-1.5" {...common} fill="none" />
        </>
      );
  }
}
