import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { ApiError } from '@window/shared';

/**
 * Input hardening.
 *
 * Every value in this file exists because MongoDB's query and update languages
 * are data. A string that reaches a query position is inert; an *object* that
 * reaches one is a program. The parsers below are the boundary at which
 * untrusted JSON stops being able to become either — they run before anything
 * is interpolated into a filter, an update, or a document key.
 */

/**
 * Keys MongoDB and JavaScript both give meaning to.
 *
 * `$` opens an operator (`{$ne: null}` matches everything, `{$gt: ''}` matches
 * every string), `.` opens a path into a nested document, and the three
 * prototype keys are how a plain JSON body becomes a change to `Object`
 * itself. None of them are legitimate in a user-supplied map, so none of them
 * are accepted anywhere.
 */
const FORBIDDEN_KEY = /^\$|\.|^__proto__$|^constructor$|^prototype$/;

export function isSafeKey(key: string): boolean {
  return !FORBIDDEN_KEY.test(key);
}

/**
 * A 24-hex MongoDB id, validated as a string before it is ever constructed.
 *
 * `new ObjectId(untrusted)` throws a raw `BSONError`, which the problem-details
 * handler can only turn into a 500 — an input mistake reported as a server
 * fault. Validating first makes it the 400 it actually is, and keeps
 * non-strings out of the filter position entirely.
 */
export const objectIdSchema = z
  .string()
  .refine((value) => ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value), {
    message: 'Expected a 24-character hexadecimal id.',
  });

export function toObjectId(value: string): ObjectId {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success) throw new Error('Refusing to construct an ObjectId from an invalid string.');
  return new ObjectId(parsed.data);
}

/**
 * Parses a path parameter into an id, or reports a 400.
 *
 * Express types a path parameter as `string | string[]`, because a route can
 * bind the same name twice — which means an untyped `new ObjectId(req.params.id)`
 * is a call that can receive an array. Funnelling every id through one function
 * makes the array case a validation failure instead of a driver exception, and
 * leaves exactly one place where an untrusted string becomes a query value.
 */
export function idParam(value: unknown, what = 'id'): ObjectId {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success) throw ApiError.validation(`Invalid ${what}.`);
  return new ObjectId(parsed.data);
}

/**
 * A bounded string map safe to store as document keys.
 *
 * Variants are the one place user input becomes a *key* rather than a value —
 * `{ "Size": "M" }` is written into the cart line and travels to the merchant
 * agent. Unbounded, that is a write primitive into the document's own shape;
 * bounded and key-filtered, it is a map of strings.
 */
export function safeRecord(options: { maxKeys?: number; maxKeyLength?: number; maxValueLength?: number } = {}) {
  const { maxKeys = 24, maxKeyLength = 64, maxValueLength = 256 } = options;

  return z
    .record(z.string().max(maxValueLength))
    .refine((record) => Object.keys(record).length <= maxKeys, {
      message: `At most ${maxKeys} entries are allowed.`,
    })
    .refine((record) => Object.keys(record).every((key) => key.length > 0 && key.length <= maxKeyLength), {
      message: `Keys must be between 1 and ${maxKeyLength} characters.`,
    })
    .refine((record) => Object.keys(record).every(isSafeKey), {
      message: 'Keys must not begin with "$", contain ".", or name a prototype property.',
    });
}

/**
 * Strips inherited and dangerous keys from a parsed object before it is stored.
 *
 * zod validates but returns the original object, which still carries whatever
 * prototype the JSON parser gave it. This rebuilds it on a null prototype so
 * that nothing downstream — a spread, a `for...in`, a Mongo serialization —
 * can pick up a key that was never in the JSON.
 */
export function sanitizeRecord(record: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    // `Object.defineProperty` rather than assignment: `clean['__proto__'] = x`
    // on a normal object mutates the prototype instead of adding a key. The
    // key filter already excludes it, and this makes the belt independent of
    // the braces.
    if (isSafeKey(key)) Object.defineProperty(clean, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return clean;
}

/**
 * Rejects a JSON body containing a prototype-poisoning key at any depth.
 *
 * Express's parser happily produces `{"__proto__": {...}}` as an own property.
 * Most of the time that is harmless; it stops being harmless the moment the
 * object is merged, cloned, or spread into something that is then trusted. It
 * is cheaper to refuse the body than to audit every consumer of it forever.
 */
export function hasPollutedKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) return value.some((entry) => hasPollutedKey(entry, depth + 1));

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (hasPollutedKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * A merchant domain, as it appears in a path parameter.
 *
 * It is used to look up a source document and to build a link URL, so it must
 * be a hostname and nothing that could be read as a path, a scheme or a
 * credential.
 */
export const merchantDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, {
    message: 'Expected a bare hostname.',
  });

/** An opaque, server-minted secret: base64url, fixed length, no wildcards. */
export const opaqueSecretSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'Expected a base64url secret.' });
