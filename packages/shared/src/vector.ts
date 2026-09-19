/**
 * Vector math. All product, category and user vectors are unit-normalized, so
 * cosine similarity reduces to a dot product — but `cosine` does not assume it,
 * because a freshly summed centroid has not been normalized yet.
 */

import { EMBEDDING_DIM } from './config.js';

export function zeros(dim = EMBEDDING_DIM): number[] {
  return new Array<number>(dim).fill(0);
}

export function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function norm(a: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (a[i] as number);
  return Math.sqrt(sum);
}

/** Cosine similarity in [-1, 1]. Returns 0 if either vector is degenerate. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Unit-normalizes in place-free fashion. A zero vector is returned unchanged. */
export function normalize(a: readonly number[]): number[] {
  const n = norm(a);
  if (n === 0) return [...a];
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) / n;
  return out;
}

export function add(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) + (b[i] ?? 0);
  return out;
}

export function scale(a: readonly number[], k: number): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) * k;
  return out;
}

/** Unweighted mean of a set of vectors, normalized. */
export function meanVector(vectors: ReadonlyArray<readonly number[]>, dim = EMBEDDING_DIM): number[] {
  if (vectors.length === 0) return zeros(dim);
  const acc = zeros(vectors[0]!.length || dim);
  for (const v of vectors) {
    for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] as number) + (v[i] ?? 0);
  }
  return normalize(scale(acc, 1 / vectors.length));
}

/** Weighted mean, normalized. Weights need not sum to one. */
export function weightedMeanVector(
  entries: ReadonlyArray<{ vector: readonly number[]; weight: number }>,
  dim = EMBEDDING_DIM,
): number[] {
  if (entries.length === 0) return zeros(dim);
  const acc = zeros(entries[0]!.vector.length || dim);
  let total = 0;
  for (const { vector, weight } of entries) {
    for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] as number) + (vector[i] ?? 0) * weight;
    total += weight;
  }
  if (total === 0) return zeros(acc.length);
  return normalize(scale(acc, 1 / total));
}

/**
 * The online user-vector update:
 *
 *   u_{t+1} = normalize((1 - alpha * w_e) * u_t + alpha * w_e * p_e)
 *
 * Negative events subtract rather than add. The sign of `w_e` carries polarity,
 * so the blend factor uses its magnitude and the product term keeps the sign.
 */
export function emaUpdate(
  current: readonly number[],
  productVector: readonly number[],
  eventWeight: number,
  alpha: number,
): number[] {
  const magnitude = Math.abs(eventWeight);
  const blend = Math.min(1, alpha * magnitude);
  const keep = 1 - blend;
  const direction = eventWeight >= 0 ? 1 : -1;
  const out = new Array<number>(current.length);
  for (let i = 0; i < current.length; i++) {
    out[i] = keep * (current[i] as number) + direction * blend * (productVector[i] ?? 0);
  }
  return normalize(out);
}

/**
 * Scalar quantization to int8, mirroring the vector index's
 * `quantization: "scalar"`. Used by the local index so its recall behaviour
 * matches Atlas rather than being silently better.
 */
export function quantizeScalar(v: readonly number[]): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const clamped = Math.max(-1, Math.min(1, v[i] as number));
    out[i] = Math.round(clamped * 127);
  }
  return out;
}

export function dequantizeScalar(q: Int8Array): number[] {
  const out = new Array<number>(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] as number) / 127;
  return out;
}

/** Dot product between an int8-quantized vector and a float query vector. */
export function quantizedDot(q: Int8Array, query: readonly number[]): number {
  let sum = 0;
  const n = Math.min(q.length, query.length);
  for (let i = 0; i < n; i++) sum += ((q[i] as number) / 127) * (query[i] as number);
  return sum;
}
