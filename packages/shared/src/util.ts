import type { Money } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Stable across platforms, which matters for bucketing. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32. Small, fast, good enough for seeding and for bucketing. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string): () => number {
  return mulberry32(hashString(seed));
}

/** Deterministic experiment bucketing on user id, as the flag service requires. */
export function bucketFor(userId: string, experiment: string, arms: string[]): string {
  if (arms.length === 0) throw new Error('bucketFor requires at least one arm');
  const h = hashString(`${experiment}:${userId}`);
  return arms[h % arms.length] as string;
}

/** Picks an item by weight using a supplied uniform source. */
export function weightedPick<T>(
  items: ReadonlyArray<{ item: T; weight: number }>,
  random: () => number,
): T | null {
  const positive = items.filter((i) => i.weight > 0);
  if (positive.length === 0) return null;
  const total = positive.reduce((s, i) => s + i.weight, 0);
  let r = random() * total;
  for (const entry of positive) {
    r -= entry.weight;
    if (r <= 0) return entry.item;
  }
  return positive[positive.length - 1]!.item;
}

/** Fisher-Yates with an injected uniform source, so shuffles are reproducible. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Percentile rank of `value` within `sorted` (ascending), in [0,1]. */
export function percentileRank(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/**
 * Bayesian smoothing of a rate against a prior mean, with prior strength `k`.
 * Used for CTR against the category mean and for ratings against the L3 prior.
 */
export function bayesianSmooth(
  successes: number,
  trials: number,
  priorMean: number,
  priorStrength: number,
): number {
  return (successes + priorMean * priorStrength) / (trials + priorStrength);
}

// ---------------------------------------------------------------------------
// Money and time
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
};

/** Minor units to a display string. JPY has no minor unit. */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOLS[money.currency] ?? `${money.currency} `;
  if (money.currency === 'JPY') return `${symbol}${Math.round(money.amount).toLocaleString()}`;
  const major = money.amount / 100;
  const hasCents = Math.round(money.amount) % 100 !== 0;
  return `${symbol}${major.toLocaleString(undefined, {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** "Ends in 2h 14m". Returns null once the auction has closed. */
export function formatTimeRemaining(endsAt: Date | string, now: Date = new Date()): string | null {
  const end = typeof endsAt === 'string' ? new Date(endsAt) : endsAt;
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86_400_000;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
