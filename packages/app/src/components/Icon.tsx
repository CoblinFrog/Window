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
    // An upward arrow rather than a heart: this is a ranking signal about a
    // product, not an emotion about a post.
    case 'upvote':
      return <Path d="M12 20V5M12 5l-6 6M12 5l6 6" {...common} />;

    case 'reviews':
      return (
        <Path
          d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z"
          {...common}
        />
      );

    case 'cart':
      return (
        <>
          <Path d="M4 8h16l-1.2 12H5.2L4 8Z" {...common} />
          <Path d="M9 8V6a3 3 0 0 1 6 0v2" {...common} fill="none" />
        </>
      );

    case 'share':
      return (
        <>
          <Path d="M12 16V3M12 3 7 8M12 3l5 5" {...common} fill="none" />
          <Path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" {...common} fill="none" />
        </>
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
