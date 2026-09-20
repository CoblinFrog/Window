/**
 * Fills the catalog with real listings, up to a target size.
 *
 *   npm run fill -w @window/server                       # top up to 20
 *   npm run fill -w @window/server -- --target 30
 *   npm run fill -w @window/server -- --topic "running shoes" --topic "espresso"
 *
 * This is the same `fillCatalog` the feed calls when a session scrolls past the
 * rotation threshold, run once from the command line — so what a fresh catalog
 * contains and what the window adds later come from one code path.
 */

import { connectDatabase } from '../db/supabase-client.js';
import { count } from '../db/supabase-helpers.js';
import { DEFAULT_WINDOW_TOPICS, fillCatalog } from '../ingestion/catalog-window.js';
import { logger } from '../lib/logger.js';
import { bootstrapCoOccurrence, primeEngagement, recomputeCentroids } from './catalog-lib.js';

const log = logger.child('fill-catalog');

function parseArgs(): { target: number; topics: string[] } {
  const args = process.argv.slice(2);
  const topics: string[] = [];
  let target = 20;

  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--topic' && value) { topics.push(value); i++; }
    else if (args[i] === '--target' && value) { target = Number.parseInt(value, 10); i++; }
  }
  return { target, topics };
}

async function main(): Promise<void> {
  const started = Date.now();
  const { target, topics } = parseArgs();

  const db = await connectDatabase();
  const { collections } = db;

  const existing = await count(collections.products, { status: 'active' });
  const needed = Math.max(0, target - existing);
  log.info('catalog size', { existing, target, needed });

  if (needed === 0) {
    log.info('already at target; nothing to fetch');
    await db.close();
    return;
  }

  const result = await fillCatalog(collections, {
    count: needed,
    topics: topics.length > 0 ? topics : DEFAULT_WINDOW_TOPICS,
  });

  // The ranker reads centroids and co-occurrence; products written without
  // refreshing them are in the catalog but not yet placeable in the feed.
  await primeEngagement(collections);
  await recomputeCentroids(collections, new Date());
  await bootstrapCoOccurrence(collections);

  log.info('done', {
    added: result.added,
    attempted: result.attempted,
    reasons: result.reasons,
    total: await count(collections.products, { status: 'active' }),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await db.close();
}

main().catch((error) => {
  log.error('fill-catalog failed', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
