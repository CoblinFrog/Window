/**
 * Supabase-specific tests for the checkout repository.
 *
 * This file runs the conformance test suite against the Supabase implementation.
 *
 * The suite begins by truncating `products`, `users`, `carts`, `orders` and
 * their neighbours, so it must never be pointed at a database anyone is using.
 * Because `SUPABASE_CONFIG` holds the one shared cloud project, running this
 * unguarded empties the development catalog and the feed answers every request
 * with "Could not load products" until it is re-seeded.
 *
 * It therefore runs only against a Supabase project named explicitly for the
 * purpose, via `TEST_SUPABASE_URL` / `TEST_SUPABASE_SERVICE_ROLE_KEY`, and
 * refuses to run against the configured development project even if those
 * variables point back at it. With no test project set it skips.
 */

import { describe, it } from 'node:test';
import { describeCheckoutRepositorySimple } from './repository.conformance.simple.js';
import { SupabaseCheckoutRepository } from './repository.supabase.js';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../config/supabase.js';

const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  describe('CheckoutRepository: supabase (simple)', () => {
    it('skipped: set TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY to run', { skip: true }, () => {});
  });
} else if (url === SUPABASE_CONFIG.url) {
  describe('CheckoutRepository: supabase (simple)', () => {
    it('skipped: TEST_SUPABASE_URL points at the development project, which this suite would truncate', { skip: true }, () => {});
  });
} else {
  describeCheckoutRepositorySimple('supabase', async () => {
    const client = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const repo = new SupabaseCheckoutRepository(client);
    await repo.truncate();
    return repo;
  });
}
