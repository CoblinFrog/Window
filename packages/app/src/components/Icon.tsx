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
  | 'share'
  | 'seller'
  | 'close'
  | 'back'
  | 'check'
  | 'grid'
  | 'single'
  | 'warning'
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
): React.ReactElement {
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
    case 'reviews':
      return (
        <>
          <Path
            d="M4 4.8h16a1 1 0 0 1 1 1v9.6a1 1 0 0 1-1 1h-6.2L12 21l-1.8-4.6H4a1 1 0 0 1-1-1V5.8a1 1 0 0 1 1-1Z"
            {...common}
          />
          <Path
            d="m12 7.6 1.32 2.76 2.93.4-2.12 2.1.52 3-2.65-1.44L9.35 15.86l.52-3-2.12-2.1 2.93-.4L12 7.6Z"
            {...common}
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

    case 'link':
      return (
        <>
          <Path d="M10 14a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 5.34l-1.5 1.5" {...common} fill="none" />
          <Path d="M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1.5-1.5" {...common} fill="none" />
        </>
      );
  }
}
