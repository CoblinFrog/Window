import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { connectDatabase } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { find } from '../db/supabase-helpers.js';
import type { Product } from '../db/supabase-collections.js';

const log = logger.child('prune-media');

/**
 * Deletes stored media that no surviving product references.
 *
 * The media directory is content-addressed and write-only: nothing ever removes
 * an entry when a product is deleted, so a catalog that has been reseeded a few
 * times accumulates every image it has ever held. At roughly 800 KB per real
 * photograph that reaches gigabytes quickly.
 *
 * The reachable set is built from the database rather than from a list of keys
 * the caller believes are live, so an image is only deleted when nothing in the
 * catalog can still ask for it.
 *
 *   npm run prune -w @window/server -- --dry-run
 *   npm run prune -w @window/server
 */

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.slice(2).includes('--dry-run') };
}

/** `http://host/media/<key>/<width>` -> `<key>` */
function keyFromUrl(url: string): string | null {
  const match = url.match(/\/media\/([^/]+)\/\d+$/);
  return match ? (match[1] as string) : null;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs();
  const db = await connectDatabase();

  // Every image any live product can still request: heroes and galleries alike.
  const reachable = new Set<string>();
  const products = await find<Product>(db.collections.products, {}, {
    select: 'media',
    limit: 10000,
  });

  for (const product of products) {
    for (const url of product.media?.hero?.avif ?? []) {
      const key = keyFromUrl(url);
      if (key) reachable.add(key);
    }
    for (const image of product.media?.gallery ?? []) {
      for (const url of image.avif ?? []) {
        const key = keyFromUrl(url);
        if (key) reachable.add(key);
      }
    }
  }

  let entries: string[];
  try {
    entries = await readdir(env.mediaDir);
  } catch {
    log.info('no media directory; nothing to prune', { dir: env.mediaDir });
    await db.close();
    return;
  }

  let removed = 0;
  let reclaimed = 0;
  let kept = 0;

  for (const entry of entries) {
    if (reachable.has(entry)) {
      kept += 1;
      continue;
    }
    const path = join(env.mediaDir, entry);
    const size = await directorySize(path).catch(() => 0);
    reclaimed += size;
    removed += 1;
    if (!dryRun) await rm(path, { recursive: true, force: true });
  }

  log.info(dryRun ? 'prune (dry run)' : 'prune complete', {
    referenced: reachable.size,
    kept,
    removed,
    reclaimedMB: Math.round(reclaimed / 1048576),
  });

  await db.close();
}

main().catch((error) => {
  log.error('prune failed', { error: (error as Error).message });
  process.exit(1);
});
