import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MEDIA_WIDTHS, QUALITY_GATE, type MediaImage, type MediaVideo } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { encodeBlurhash } from './blurhash.js';
import { renderProductImage } from './generator.js';
import { encodePng } from './png.js';
import { CompositeMediaPipeline, FetchedMediaPipeline } from './fetched.js';

const log = logger.child('media');

/**
 * Media handling.
 *
 * Source images are fetched once, transcoded at three widths, stripped of
 * metadata and served from object storage behind a CDN. Hotlinking is not
 * acceptable: it is slow, it breaks when a source rotates URLs, and it puts
 * load on the source. Every implementation of this interface must honour that.
 */
export interface MediaPipeline {
  readonly kind: string;
  /** The format the stored derivatives are encoded in. */
  readonly format: 'avif' | 'webp' | 'png';
  /**
   * Ingests one image and returns the stored derivative set, or null when the
   * image fails the eligibility floor (800 px on the short edge).
   */
  ingestImage(input: ImageIngestInput): Promise<MediaImage | null>;
  ingestVideo(input: VideoIngestInput): Promise<MediaVideo | null>;
  /** Resolves stored bytes for a derivative, rendering it on first request. */
  resolve(key: string, width: number): Promise<{ body: Buffer; contentType: string } | null>;
}

export interface ImageIngestInput {
  /** Stable identity of the source image; also the storage key seed. */
  sourceUrl: string;
  /** Declared source dimensions, used for the eligibility gate. */
  width: number;
  height: number;
}

export interface VideoIngestInput {
  sourceUrl: string;
  durationMs: number;
}

function storageKey(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24);
}

/**
 * The generated pipeline.
 *
 * With no source photographs to fetch and no native image codec available, it
 * synthesises deterministic imagery instead of transcoding. Everything else
 * matches the real thing: three widths, our own URLs rather than the source's,
 * a blurhash computed at ingest, long-lived CDN cache headers, and derivatives
 * materialised to object storage.
 *
 * It emits PNG. A libvips-backed pipeline implementing this same interface is
 * what emits AVIF and WebP against real source images; the `MediaImage` schema
 * carries both URL lists so that swap needs no migration. Until then both lists
 * point at the same extension-less URLs, which are content-negotiated by the
 * `Content-Type` header rather than by their suffix.
 */
export class GeneratedMediaPipeline implements MediaPipeline {
  readonly kind = 'generated';
  readonly format = 'png' as const;

  constructor(private readonly root: string = env.mediaDir) {}

  private urlFor(key: string, width: number): string {
    return `${env.publicUrl}/media/${key}/${width}`;
  }

  private pathFor(key: string, width: number): string {
    return join(this.root, key, `${width}.png`);
  }

  async ingestImage(input: ImageIngestInput): Promise<MediaImage | null> {
    // A product needs at least one image of 800 px or more on the short edge to
    // be eligible for the feed.
    const shortEdge = Math.min(input.width, input.height);
    if (shortEdge < QUALITY_GATE.minImageShortEdge) {
      log.debug('image rejected below the eligibility floor', {
        sourceUrl: input.sourceUrl,
        shortEdge,
      });
      return null;
    }

    const key = storageKey(input.sourceUrl);
    const aspect = input.width / input.height;

    // The blurhash is computed at ingest from a small render; at 32 px the DCT
    // is free and the result is identical to hashing the full-size image.
    const thumbHeight = 32;
    const thumbWidth = Math.max(8, Math.round(32 * aspect));
    const thumb = renderProductImage(key, thumbWidth, thumbHeight);
    const blurhash = encodeBlurhash(thumb.pixels, thumb.width, thumb.height, 4, 3);

    const urls = MEDIA_WIDTHS.map((w) => this.urlFor(key, w));
    const largest = MEDIA_WIDTHS[MEDIA_WIDTHS.length - 1] as number;

    return {
      avif: urls,
      webp: urls,
      width: largest,
      height: Math.round(largest / aspect),
      blurhash,
    };
  }

  async ingestVideo(input: VideoIngestInput): Promise<MediaVideo | null> {
    // Video is used when the source provides it, transcoded to HLS and capped
    // at 15 seconds. The generated catalog has no source video and this
    // pipeline has no transcoder, so it declines rather than fabricating a
    // manifest that would 404 on the first play. A card must be complete with a
    // still image alone, which is exactly why that is safe.
    void input;
    return null;
  }

  /**
   * Renders and materialises a derivative on first request, then serves it from
   * disk. This is the object-storage origin behind the CDN: the first request
   * for a width pays for the encode, every later one is a file read, and the
   * client sees immutable, far-future-cacheable bytes either way.
   */
  async resolve(key: string, width: number): Promise<{ body: Buffer; contentType: string } | null> {
    if (!/^[a-f0-9]{8,64}$/.test(key)) return null;
    if (!(MEDIA_WIDTHS as readonly number[]).includes(width)) return null;

    const path = this.pathFor(key, width);
    if (existsSync(path)) {
      return { body: await readFile(path), contentType: 'image/png' };
    }

    const image = renderProductImage(key, width, width);
    const body = encodePng(image);
    await mkdir(join(this.root, key), { recursive: true });
    await writeFile(path, body);
    return { body, contentType: 'image/png' };
  }
}

let shared: MediaPipeline | null = null;

/**
 * The default origin serves both kinds of media: real listings carry fetched
 * bytes under `f_` keys, synthetic ones are generated on demand. Routing by key
 * prefix means a database holding both does not 404 half its images.
 */
export function mediaPipeline(): MediaPipeline {
  if (!shared) {
    shared = new CompositeMediaPipeline(
      new GeneratedMediaPipeline(),
      new FetchedMediaPipeline(),
    );
  }
  return shared;
}

export function setMediaPipeline(pipeline: MediaPipeline): void {
  shared = pipeline;
}
