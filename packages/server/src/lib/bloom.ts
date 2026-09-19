/**
 * The seen-set Bloom filter stored on the user document.
 *
 * The feed's hard-filter stage drops anything seen in the last 30 days. Keeping
 * an exact set would grow without bound, so the PRD specifies a Bloom filter
 * rebuilt weekly from the interaction log. False positives cost a product the
 * user never actually saw; false negatives are impossible, which is the right
 * way round — showing a repeat is worse than skipping one candidate out of 400.
 */

import type { BloomFilterState } from '@window/shared';
import { hashString } from '@window/shared';

export const DEFAULT_M = 200_000;
export const DEFAULT_K = 7;

export interface Bloom {
  bits: Uint8Array;
  k: number;
  m: number;
  n: number;
}

export function createBloom(m = DEFAULT_M, k = DEFAULT_K): Bloom {
  return { bits: new Uint8Array(Math.ceil(m / 8)), k, m, n: 0 };
}

/**
 * Kirsch-Mitzenmacher double hashing: k indexes from two independent 32-bit
 * hashes, which is indistinguishable from k independent hashes in practice.
 */
function indexes(value: string, m: number, k: number): number[] {
  const h1 = hashString(value);
  // Salted so the second hash is genuinely independent of the first rather
  // than a rotation of it, and forced odd so the stride never shares a factor with m.
  const h2 = hashString(`bloom-salt:${value}`) | 1;
  const out = new Array<number>(k);
  for (let i = 0; i < k; i++) {
    out[i] = ((h1 + Math.imul(i, h2)) >>> 0) % m;
  }
  return out;
}

export function bloomAdd(bloom: Bloom, value: string): void {
  let novel = false;
  for (const idx of indexes(value, bloom.m, bloom.k)) {
    const byte = idx >> 3;
    const mask = 1 << (idx & 7);
    if (((bloom.bits[byte] as number) & mask) === 0) novel = true;
    bloom.bits[byte] = (bloom.bits[byte] as number) | mask;
  }
  if (novel) bloom.n += 1;
}

export function bloomHas(bloom: Bloom, value: string): boolean {
  for (const idx of indexes(value, bloom.m, bloom.k)) {
    const byte = idx >> 3;
    const mask = 1 << (idx & 7);
    if (((bloom.bits[byte] as number) & mask) === 0) return false;
  }
  return true;
}

/** Estimated false-positive rate at the current load. Drives the rebuild job. */
export function bloomFalsePositiveRate(bloom: Bloom): number {
  if (bloom.n === 0) return 0;
  return (1 - Math.exp((-bloom.k * bloom.n) / bloom.m)) ** bloom.k;
}

export function serializeBloom(bloom: Bloom, rebuiltAt: Date): BloomFilterState {
  return {
    bits: Buffer.from(bloom.bits).toString('base64'),
    k: bloom.k,
    m: bloom.m,
    n: bloom.n,
    rebuiltAt,
  };
}

export function deserializeBloom(state: BloomFilterState | null | undefined): Bloom {
  if (!state) return createBloom();
  const bytes = Buffer.from(state.bits, 'base64');
  const expected = Math.ceil(state.m / 8);
  const bits = new Uint8Array(expected);
  bits.set(bytes.subarray(0, Math.min(bytes.length, expected)));
  return { bits, k: state.k, m: state.m, n: state.n ?? 0 };
}
