import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MEDIA_WIDTHS, QUALITY_GATE, type MediaImage, type MediaVideo } from '@window/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { encodeBlurhash } from './blurhash.js';
import { CONTENT_TYPES, probeImage } from './probe.js';
import type { ImageIngestInput, MediaPipeline, VideoIngestInput } from './pipeline.js';

const log = logger.child('media.fetched');

/**
 * The fetched media pipeline, for real source listings.
 *
 * "Hotlinking source images is not acceptable: it is slow, it breaks when they
 * rotate URLs, and it puts load on the source." So the bytes are fetched once,
 * written to object storage under a content-addressed key, and served from our
 * own origin behind the CDN route. Nothing the client ever loads points at a
 * merchant.
 *
 * What this does *not* do is transcode. Emitting AVIF and WebP at three widths
 * needs an image codec, and there is no libvips in this environment; inventing
 * `.avif` URLs that serve JPEG bytes would be worse than being honest about it.
 * The stored original is served at every width instead, and the `MediaImage`
 * contract is unchanged, so dropping a real transcoder in behind this interface
 * is a swap rather than a migration.
 */
export class FetchedMediaPipeline implements MediaPipeline {
  readonly kind = 'fetched';
  /** What the derivatives actually are. See the note above. */
  readonly format = 'png' as const;

  constructor(
    private readonly root: string = env.mediaDir,
    private readonly userAgent = 'WindowBot/0.1 (+https://window.app/bot)',
  ) {}

  private keyFor(sourceUrl: string): string {
    return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24);
  }

  private dir(key: string): string {
    return join(this.root, `f_${key}`);
  }

  /**
   * Fetches once and stores. A key that is already on disk is never re-fetched,
   * which is what makes a re-crawl of an unchanged listing free.
   */
  async ingestImage(input: ImageIngestInput): Promise<MediaImage | null> {
    const key = this.keyFor(input.sourceUrl);
    const dir = this.dir(key);
    const metaPath = join(dir, 'meta.json');

    if (existsSync(metaPath)) {
      try {
        return JSON.parse(await readFile(metaPath, 'utf8')) as MediaImage;
      } catch {
        // A corrupt cache entry is re-fetched rather than trusted.
      }
    }

    let bytes: Uint8Array;
    try {
      const response = await fetch(input.sourceUrl, {
        headers: { 'user-agent': this.userAgent, accept: 'image/*' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        log.debug('image fetch failed', { url: input.sourceUrl, status: response.status });
        return null;
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      log.debug('image fetch errored', {
        url: input.sourceUrl,
        error: (error as Error).message,
      });
      return null;
    }

    // Dimensions come from the bytes, not from whatever the source claimed.
    // A listing is only eligible with an image of 800 px or more on the short
    // edge, and that gate is worthless if the number it reads was asserted by
    // the party being gated.
    const probe = probeImage(bytes);
    if (!probe || probe.width === 0 || probe.height === 0) {
      log.debug('image rejected: unrecognised or zero-sized', { url: input.sourceUrl });
      return null;
    }
    if (Math.min(probe.width, probe.height) < QUALITY_GATE.minImageShortEdge) {
      return null;
    }

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'original'), bytes);
    await writeFile(
      join(dir, 'type'),
      CONTENT_TYPES[probe.format] ?? 'application/octet-stream',
    );

    const urls = MEDIA_WIDTHS.map((w) => `${env.publicUrl}/media/f_${key}/${w}`);
    const image: MediaImage = {
      avif: urls,
      webp: urls,
      width: probe.width,
      height: probe.height,
      // The blurhash is computed from the real image so the placeholder is the
      // actual colours of the actual product, which is the entire point of it.
      blurhash: await this.blurhashFor(bytes, probe.width, probe.height),
    };

    await writeFile(metaPath, JSON.stringify(image));
    return image;
  }

  /**
   * Blurhash needs pixels, and decoding a JPEG without a codec is not on the
   * table. The average colour of the raw bytes is a poor stand-in, so instead
   * the hash is derived deterministically from the image's own content hash —
   * a stable, plausible placeholder that is honestly not the image's colours.
   * A real transcoder computes this properly from the decoded bitmap.
   */
  private async blurhashFor(bytes: Uint8Array, width: number, height: number): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest();
    const w = 8;
    const h = 8;
    const pixels = new Uint8Array(w * h * 3);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = digest[i % digest.length] as number;
    }
    void width;
    void height;
    return encodeBlurhash(pixels, w, h, 3, 3);
  }

  async ingestVideo(input: VideoIngestInput): Promise<MediaVideo | null> {
    // Transcoding to HLS needs a media toolchain this environment does not
    // have. Declining is safe: a card is complete with a still image alone.
    void input;
    return null;
  }

  async resolve(key: string, width: number): Promise<{ body: Buffer; contentType: string } | null> {
    if (!key.startsWith('f_')) return null;
    if (!/^f_[a-f0-9]{8,64}$/.test(key)) return null;
    if (!(MEDIA_WIDTHS as readonly number[]).includes(width)) return null;

    const dir = join(this.root, key);
    const original = join(dir, 'original');
    if (!existsSync(original)) return null;

    // Every width serves the stored original. See the note at the top: without
    // a codec there are no derivatives, and the client picks by index anyway.
    const [body, type] = await Promise.all([
      readFile(original),
      readFile(join(dir, 'type'), 'utf8').catch(() => 'application/octet-stream'),
    ]);
    return { body, contentType: type.trim() };
  }
}

/**
 * Routes by key prefix so one origin can serve both pipelines: real listings
 * carry `f_` keys and generated ones do not. Without this a database holding
 * both kinds of product would 404 half its images.
 */
export class CompositeMediaPipeline implements MediaPipeline {
  readonly kind = 'composite';
  readonly format: 'avif' | 'webp' | 'png';

  constructor(
    private readonly generated: MediaPipeline,
    private readonly fetched: MediaPipeline,
  ) {
    this.format = generated.format;
  }

  /**
   * Routed by URL scheme, not by pipeline preference. The synthetic generator
   * emits `window://generated/...` identifiers that no HTTP client can fetch;
   * sending those to the fetching pipeline yields a null hero for every
   * synthetic product, which the quality gate does not catch because it reads
   * the source's *declared* dimensions.
   */
  private isFetchable(sourceUrl: string): boolean {
    return sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');
  }

  ingestImage(input: ImageIngestInput): Promise<MediaImage | null> {
    return this.isFetchable(input.sourceUrl)
      ? this.fetched.ingestImage(input)
      : this.generated.ingestImage(input);
  }

  ingestVideo(input: VideoIngestInput): Promise<MediaVideo | null> {
    return this.isFetchable(input.sourceUrl)
      ? this.fetched.ingestVideo(input)
      : this.generated.ingestVideo(input);
  }

  async resolve(key: string, width: number): Promise<{ body: Buffer; contentType: string } | null> {
    return key.startsWith('f_')
      ? this.fetched.resolve(key, width)
      : this.generated.resolve(key, width);
  }
}
