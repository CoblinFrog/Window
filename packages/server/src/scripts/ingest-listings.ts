/**
 * Puts the output of the two product-facing functions into Supabase.
 *
 * `lookupListing` resolves a marketplace link to the listing behind it, and
 * `expandFromWeb` — the web leg `recommendListings` runs on — turns words into
 * fresh listings. Both hand back `RawListing`s, so both are written through the
 * one ingestion pipeline: same normalization, media, clustering and upsert the
 * crawler uses, so a product means the same thing however it was found.
 *
 *   npm run ingest:listings -w @window/server -- --url https://www.ebay.com/itm/123 --url ...
 *   npm run ingest:listings -w @window/server -- --topic "mechanical keyboard" --count 4
 *
 * `--dry-run` resolves and prints without touching the database.
 */

import { connectDatabase } from '../db/supabase-client.js';
import { claudeCli } from '../agent/llm.js';
import { expandFromWeb } from '../feed/web-expand.js';
import { lookupListing } from '../ingestion/lookup.js';
import { createWebIngestion, persistWebListings } from '../ingestion/web-persistence.js';
import type { RawListing } from '../ingestion/types.js';
import { logger } from '../lib/logger.js';
import { bootstrapCoOccurrence, primeEngagement, recomputeCentroids } from './catalog-lib.js';

const log = logger.child('ingest-listings');

interface Options {
  urls: string[];
  topics: string[];
  count: number;
  dryRun: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const urls: string[] = [];
  const topics: string[] = [];
  let count = 4;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--url' && value) { urls.push(value); i++; }
    else if (flag === '--topic' && value) { topics.push(value); i++; }
    else if (flag === '--count' && value) { count = Number.parseInt(value, 10); i++; }
    // A bare URL is the common case; accept it without the flag.
    else if (flag?.startsWith('http')) urls.push(flag);
  }

  return { urls, topics, count, dryRun: args.includes('--dry-run') };
}

/** Resolves each link through `lookupListing`, reporting what each one gave. */
async function fromUrls(urls: string[]): Promise<RawListing[]> {
  const listings: RawListing[] = [];

  for (const url of urls) {
    try {
      // Caching a lookup is right for a tap in the app and wrong here, where
      // the point is to read the source as it is now.
      const result = await lookupListing(url, { cacheTtlMs: 0 });
      if (result.listing && result.status === 'ok') {
        listings.push(result.listing);
        log.info('resolved listing', {
          url,
          title: result.listing.title?.slice(0, 60) ?? null,
          priceMinor: result.listing.priceAmountMinor,
          images: result.listing.images.length,
          reviews: result.listing.reviews.length,
        });
      } else {
        log.warn('lookup returned no usable listing', { url, status: result.status });
      }
    } catch (error) {
      log.warn('lookup failed', { url, error: (error as Error).message });
    }
  }

  return listings;
}

/**
 * The web leg of `recommendListings`, run directly.
 *
 * `recommendListings` blends catalog rows with these, but only the web half
 * produces listings that are not in the database yet, and those are the only
 * ones there is anything to ingest.
 */
async function fromTopics(topics: string[], needed: number): Promise<RawListing[]> {
  // Query suggestion is the only place a model is used, and it already falls
  // back to deriving queries from the topics when the CLI is unavailable.
  const listings = await expandFromWeb(topics, needed, { llm: claudeCli() });
  log.info('web expansion complete', { topics, found: listings.length });
  return listings;
}

async function main(): Promise<void> {
  const started = Date.now();
  const options = parseArgs();

  if (options.urls.length === 0 && options.topics.length === 0) {
    log.error('nothing to do: pass --url <link> or --topic "<words>"');
    process.exit(1);
  }

  const collected = [
    ...(options.urls.length > 0 ? await fromUrls(options.urls) : []),
    ...(options.topics.length > 0 ? await fromTopics(options.topics, options.count) : []),
  ];

  // Two paths can surface the same item; the pipeline would treat the second as
  // an update, but de-duplicating here keeps the reported counts honest.
  const unique = [...new Map(collected.map((l) => [`${l.sourceDomain}:${l.sourceId}`, l])).values()];
  log.info('collected listings', { total: unique.length, unique: unique.length });

  if (unique.length === 0) {
    log.error('nothing was collected; the database was left untouched');
    process.exit(1);
  }

  if (options.dryRun) {
    for (const l of unique) {
      log.info('would ingest', {
        domain: l.sourceDomain,
        sourceId: l.sourceId,
        title: l.title?.slice(0, 60) ?? null,
        priceMinor: l.priceAmountMinor,
        images: l.images.length,
      });
    }
    return;
  }

  const db = await connectDatabase();
  const { collections } = db;

  const pipeline = await createWebIngestion(collections, unique);
  const stats = await persistWebListings(
    pipeline,
    unique,
    options.count,
    new Date(),
    (listing, error) => log.warn('ingest failed', {
      sourceId: listing.sourceId,
      error: (error as Error).message,
    }),
  );

  log.info('ingestion complete', { ...stats });

  // The feed reads centroids and co-occurrence, so a write that skipped them
  // would land products the ranker cannot yet place.
  await primeEngagement(collections);
  await recomputeCentroids(collections, new Date());
  await bootstrapCoOccurrence(collections);

  log.info('done', { seconds: Math.round((Date.now() - started) / 1000) });
  await db.close();
}

main().catch((error) => {
  log.error('ingest-listings failed', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
