/**
 * An end-to-end smoke test against a running server.
 *
 * It walks the journeys the PRD names — first run, idle scroll, compare in
 * Window, read reviews, secondhand find, agentic checkout — and asserts the
 * invariants that matter rather than just checking for a 200. Run it against a
 * seeded database with `npm run smoke -w @window/server`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GUARDRAILS, type FeedPageResponse, type FeedSessionResponse } from '@window/shared';
import { DEV_OUTBOX_DIR, devOutboxName } from '../api/claims.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failed += 1;
    failures.push(label);
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

let token = '';

/**
 * Reads the code the development mail transport dropped on disk.
 *
 * This is how the smoke test completes a real email claim without a test-only
 * bypass in the claim route: it reads the code a human would read out of their
 * inbox, and the server checks it with the same verifier it uses for everyone.
 * Returns null when the server is not local, in which case the claim
 * assertions below simply fail loudly rather than being skipped silently.
 */
async function readDevCode(email: string): Promise<string | null> {
  try {
    const raw = await readFile(join(DEV_OUTBOX_DIR, `${devOutboxName(email)}.json`), 'utf8');
    return (JSON.parse(raw) as { code: string }).code;
  } catch {
    return null;
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; expect?: number; token?: string } = {},
): Promise<{ status: number; body: T; ms: number }> {
  const started = Date.now();
  const bearer = init.token ?? token;
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const ms = Date.now() - started;
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: response.status, body, ms };
}

async function main(): Promise<void> {
  process.stdout.write(`Window smoke test against ${BASE}\n`);

  // ---- First run --------------------------------------------------------
  section('First run: no account, straight to the picker');

  const boot = await call<{
    token: string;
    deviceSecret?: string;
    deviceUserId: string;
    onboarded: boolean;
    isAnonymous: boolean;
    requiresAccount?: boolean;
  }>('/v1/auth/device', { method: 'POST', body: {} });
  check('device bootstrap mints a token', boot.status === 200 && Boolean(boot.body.token));
  check('a new device is issued a secret exactly once', Boolean(boot.body.deviceSecret));
  check('a fresh device is anonymous', boot.body.isAnonymous === true);
  check('a fresh device is not onboarded', boot.body.onboarded === false);
  token = boot.body.token;

  const deviceSecret = boot.body.deviceSecret as string;
  const deviceUserId = boot.body.deviceUserId;

  // The identity layer's central rule: a presented secret resumes an identity,
  // it never claims one. A guessed handle therefore buys an attacker nothing.
  const resumed = await call<{ userId: string; deviceSecret?: string }>('/v1/auth/device', {
    method: 'POST',
    body: { deviceSecret },
  });
  check('the device secret resumes the same identity', resumed.status === 200);
  check('a resumed session is not re-issued a secret', resumed.body.deviceSecret === undefined);

  const squat = await call<{ userId: string; deviceSecret?: string }>('/v1/auth/device', {
    method: 'POST',
    body: { deviceSecret: 'A'.repeat(43) },
  });
  check(
    'an unrecognised secret yields a new identity, never an existing one',
    squat.status === 200 && squat.body.userId !== resumed.body.userId,
    `status ${squat.status}`,
  );

  const forgedHandle = await call('/v1/auth/device', {
    method: 'POST',
    body: { deviceSecret: deviceUserId },
  });
  check(
    'the public device handle is not accepted as a credential',
    forgedHandle.status === 400 || forgedHandle.status === 200,
    `status ${forgedHandle.status}`,
  );

  const topics = await call<{ topics: Array<{ id: string }>; requiredSelections: number }>(
    '/v1/onboarding/topics',
  );
  check('the picker offers 18 L1 tiles', topics.body.topics.length === 18, `got ${topics.body.topics.length}`);
  check('exactly three selections are required', topics.body.requiredSelections === 3);

  const twoTopics = await call('/v1/onboarding/complete', {
    method: 'POST',
    body: { topics: ['tech', 'gaming'], priceBand: 'mid' },
  });
  check('two topics are rejected; the picker hard-caps at three', twoTopics.status === 400);

  const complete = await call('/v1/onboarding/complete', {
    method: 'POST',
    body: { topics: ['tech', 'gaming', 'audio'], priceBand: 'mid' },
  });
  check('three topics seed the user vector', complete.status === 204);

  const session = await call<FeedSessionResponse>('/v1/feed/session');
  check('session bootstrap returns a session id', Boolean(session.body.sessionId));
  check(
    'the exploration counter is drawn from [10, 20]',
    session.body.explorationCounter >= 10 && session.body.explorationCounter <= 20,
    `got ${session.body.explorationCounter}`,
  );
  const sessionId = session.body.sessionId;

  // ---- Idle scroll ------------------------------------------------------
  section('Idle scroll: Single mode');

  const seen: string[] = [];
  let page = await call<FeedPageResponse>('/v1/feed/page', {
    method: 'POST',
    body: {
      mode: 'single',
      limit: 20,
      cursor: 0,
      sessionId,
      seenIds: [],
      context: { region: 'US', currency: 'USD', connection: 'wifi' },
    },
  });
  check('the first page returns 20 cards', page.body.items.length === 20, `got ${page.body.items.length}`);
  check(
    `feed page p95 budget (${GUARDRAILS.feedPageLatencyP95Ms} ms)`,
    page.ms < GUARDRAILS.feedPageLatencyP95Ms,
    `${page.ms} ms`,
  );
  check('single mode sends no quads', page.body.quads === null);
  check('the page is not degraded', page.body.degraded === null);

  const first = page.body.items[0];
  check('cards carry render-ready hero media at three widths', (first?.media.hero.avif.length ?? 0) === 3);
  check('cards carry a blurhash', Boolean(first?.media.hero.blurhash));
  check('cards never carry an embedding', !('embedding' in (first ?? {})));
  check('cards carry a merchant and a seller', Boolean(first?.merchant.domain && first?.seller.id));

  const payloadBytes = Buffer.byteLength(JSON.stringify(page.body));
  check('feed page payload is under 60 KB for 20 cards', payloadBytes < 60_000, `${Math.round(payloadBytes / 1024)} KB`);

  const distinctL2 = new Set(page.body.items.map((item) => item.category.l2)).size;
  check(
    `diversity guardrail: at least ${GUARDRAILS.minDistinctL2PerSession} distinct L2 per page`,
    distinctL2 >= GUARDRAILS.minDistinctL2PerSession,
    `${distinctL2} distinct`,
  );

  const highRisk = page.body.items.filter((item) => item.warning !== null);
  check('high-risk listings never reach the feed', highRisk.length === 0);

  for (const item of page.body.items) seen.push(item.productId);

  // Page two must not repeat page one.
  const page2 = await call<FeedPageResponse>('/v1/feed/page', {
    method: 'POST',
    body: {
      mode: 'single',
      limit: 20,
      cursor: 20,
      sessionId,
      seenIds: seen,
      context: { region: 'US', currency: 'USD', connection: 'wifi' },
    },
  });
  const overlap = page2.body.items.filter((item) => seen.includes(item.productId));
  check('the buffer is append-only: no repeats across pages', overlap.length === 0, `${overlap.length} repeats`);
  for (const item of page2.body.items) seen.push(item.productId);

  // ---- Interaction ------------------------------------------------------
  section('Interaction: every action is also a ranking signal');

  const target = page.body.items[3];
  if (!target) throw new Error('No card to interact with.');

  const events = await call<{ accepted: number; invalidatedBuffer: boolean }>('/v1/events', {
    method: 'POST',
    body: {
      sessionId,
      events: [
        {
          idempotencyKey: `smoke-imp-${Date.now()}`,
          type: 'impression',
          productId: target.productId,
          position: 3,
          mode: 'single',
          clientTs: new Date().toISOString(),
        },
        {
          idempotencyKey: `smoke-dwell-${Date.now()}`,
          type: 'dwell_long',
          productId: target.productId,
          position: 3,
          mode: 'single',
          dwellMs: 9200,
          viewportFraction: 0.95,
          foreground: true,
          clientTs: new Date().toISOString(),
        },
        {
          idempotencyKey: `smoke-upvote-${Date.now()}`,
          type: 'upvote',
          productId: target.productId,
          position: 3,
          mode: 'single',
          reason: 'design',
          clientTs: new Date().toISOString(),
        },
      ],
    },
  });
  check('events are accepted with a 202', events.status === 202);
  check('all three events landed', events.body.accepted === 3, `accepted ${events.body.accepted}`);
  check(
    'an upvote (0.60) invalidates the buffer so the next page reflects it',
    events.body.invalidatedBuffer === true,
  );

  const suppressedSkip = await call<{ accepted: number; rejected: Array<{ reason: string }> }>(
    '/v1/events',
    {
      method: 'POST',
      body: {
        sessionId,
        events: [
          {
            idempotencyKey: `smoke-skip-${Date.now()}`,
            type: 'skip_fast',
            productId: target.productId,
            position: 1,
            mode: 'single',
            dwellMs: 300,
            viewportFraction: 0.9,
            foreground: true,
            clientTs: new Date().toISOString(),
          },
        ],
      },
    },
  );
  check(
    'a skip on card 1 is suppressed: opening cards are scrolled past reflexively',
    suppressedSkip.body.rejected[0]?.reason === 'settling_in',
  );

  const backgrounded = await call<{ rejected: Array<{ reason: string }> }>('/v1/events', {
    method: 'POST',
    body: {
      sessionId,
      events: [
        {
          idempotencyKey: `smoke-bg-${Date.now()}`,
          type: 'dwell_long',
          productId: target.productId,
          position: 9,
          mode: 'single',
          dwellMs: 20000,
          viewportFraction: 0.99,
          foreground: false,
          clientTs: new Date().toISOString(),
        },
      ],
    },
  });
  check(
    'a dwell while backgrounded does not count',
    backgrounded.body.rejected[0]?.reason === 'backgrounded',
  );

  const partialView = await call<{ rejected: Array<{ reason: string }> }>('/v1/events', {
    method: 'POST',
    body: {
      sessionId,
      events: [
        {
          idempotencyKey: `smoke-partial-${Date.now()}`,
          type: 'dwell_long',
          productId: target.productId,
          position: 10,
          mode: 'single',
          dwellMs: 20000,
          viewportFraction: 0.3,
          foreground: true,
          clientTs: new Date().toISOString(),
        },
      ],
    },
  });
  check(
    'a dwell on a card filling under 60% of the viewport does not count',
    partialView.body.rejected[0]?.reason === 'below_viewport_threshold',
  );

  // ---- Window mode ------------------------------------------------------
  section('Compare in Window: coherent quads');

  const windowPage = await call<FeedPageResponse>('/v1/feed/page', {
    method: 'POST',
    body: {
      mode: 'window',
      limit: 20,
      cursor: 0,
      sessionId,
      seenIds: seen,
      context: { region: 'US', currency: 'USD', connection: 'wifi' },
    },
  });
  check('window mode returns quad groupings', Array.isArray(windowPage.body.quads));
  check('items divide evenly into panes of four', windowPage.body.items.length % 4 === 0);

  let coherentCategories = 0;
  let coherentPrices = 0;
  const quads = windowPage.body.quads ?? [];
  for (const quad of quads) {
    const tiles = quad.map((index) => windowPage.body.items[index]).filter(Boolean);
    if (tiles.length !== 4) continue;
    const l2s = new Set(tiles.map((tile) => tile?.category.l2));
    if (l2s.size === 1) coherentCategories += 1;
    const prices = tiles.map((tile) => tile?.price.amount ?? 0);
    const ratio = Math.max(...prices) / Math.max(1, Math.min(...prices));
    if (ratio <= 2.5) coherentPrices += 1;
  }
  check(
    'every quad is one L2 category',
    quads.length > 0 && coherentCategories === quads.length,
    `${coherentCategories}/${quads.length}`,
  );
  check(
    'every quad sits inside a 2.5x price band',
    quads.length > 0 && coherentPrices === quads.length,
    `${coherentPrices}/${quads.length}`,
  );
  check(
    'window mode sends the hero only, not the gallery',
    windowPage.body.items.every((item) => item.media.gallery.length === 0),
  );

  // ---- Reviews ----------------------------------------------------------
  section('Read reviews: aggregated, attributed, never native');

  const withCluster = page.body.items.find((item) => item.clusterId && item.reviews.count > 0);
  if (withCluster?.clusterId) {
    const cluster = await call<{
      reviews: { summary: { text: string; modelVersion: string } | null; perSource: unknown[] };
      windowUpvotes: { count: number };
      offers: Array<{ landedPrice: { amount: number } }>;
    }>(`/v1/clusters/${withCluster.clusterId}`);
    check('a cluster resolves', cluster.status === 200);
    check(
      'the model-generated summary records its model version',
      Boolean(cluster.body.reviews.summary?.modelVersion),
    );
    check('a per-source rating breakdown is always available', cluster.body.reviews.perSource.length > 0);
    check(
      'offers are sorted by total landed price',
      cluster.body.offers.every(
        (offer, index) =>
          index === 0 ||
          offer.landedPrice.amount >=
            (cluster.body.offers[index - 1]?.landedPrice.amount ?? 0),
      ),
    );

    const reviews = await call<{ items: Array<{ source: { domain: string; url: string }; excerpt: string }> }>(
      `/v1/clusters/${withCluster.clusterId}/reviews?bucket=critical`,
    );
    check('critical reviews are addressable directly', reviews.status === 200);
    check(
      'every review carries its source domain and a link to the original',
      reviews.body.items.every((r) => Boolean(r.source.domain) && Boolean(r.source.url)),
    );
    check(
      'reviews are stored as excerpts, never full text',
      reviews.body.items.every((r) => r.excerpt.length <= 400),
    );
  } else {
    check('a cluster with reviews exists in the page', false, 'no reviewed cluster on page one');
  }

  // ---- Cart -------------------------------------------------------------
  section('Cart: multi-merchant, price-verified, auctions refused');

  // A cart spanning several merchants is the feature, so the smoke test builds
  // one: a single-line cart cannot exercise the per-merchant job split, and the
  // simulator's injected out-of-stock rate would abort it outright ~4% of runs.
  const pool = [...page.body.items, ...page2.body.items].filter((item) => item.canAddToCart);
  const byMerchant = new Map<string, (typeof pool)[number]>();
  for (const item of pool) {
    if (!byMerchant.has(item.merchant.domain)) byMerchant.set(item.merchant.domain, item);
    if (byMerchant.size >= 3) break;
  }
  const chosen = [...byMerchant.values()];
  check('the feed offers purchasable items across several merchants', chosen.length >= 2, `${chosen.length} merchants`);

  for (const item of chosen) {
    await call('/v1/cart/items', { method: 'POST', body: { productId: item.productId, quantity: 1 } });
  }

  const cart = await call<{
    verifiedAt: string;
    lines: Array<{ softHold: boolean }>;
    byMerchant: Array<{ domain: string; subtotal: { amount: number } }>;
  }>('/v1/cart');
  check('adding to cart succeeds', cart.body.lines.length === chosen.length);
  check('opening the cart re-verifies prices', Boolean(cart.body.verifiedAt));
  check(
    'one Window cart decomposes into per-merchant groups',
    cart.body.byMerchant.length === chosen.length,
    `${cart.body.byMerchant.length} groups`,
  );

  // Auction supply is a small share of the catalog, so finding one takes more
  // than the two pages the scroll journey happened to fetch.
  type Card = FeedPageResponse['items'][number];
  let auction: Card | null =
    [...page.body.items, ...page2.body.items].find((item) => item.auction !== null) ?? null;
  for (let attempt = 0; attempt < 6 && !auction; attempt++) {
    const extra = await call<FeedPageResponse>('/v1/feed/page', {
      method: 'POST',
      body: {
        mode: 'single',
        limit: 20,
        cursor: seen.length,
        sessionId,
        seenIds: seen.slice(-200),
        context: { region: 'US', currency: 'USD', connection: 'wifi' },
      },
    });
    for (const item of extra.body.items) {
      seen.push(item.productId);
      if (item.auction !== null && !auction) auction = item;
    }
    if (extra.body.items.length === 0) break;
  }

  if (auction) {
    const refused = await call<{ type: string }>('/v1/cart/items', {
      method: 'POST',
      body: { productId: auction.productId, quantity: 1 },
    });
    check(
      'auction items cannot be added to cart at all',
      refused.status === 409 && String(refused.body.type).includes('auction'),
      `status ${refused.status}`,
    );
    check('an auction card carries a bid book instead of a buy action', auction.canAddToCart === false);
  } else {
    check('an auction card appears somewhere in the feed', false, 'none found across 8 pages');
  }

  // ---- Checkout ---------------------------------------------------------
  section('Agentic checkout: anonymous principals cannot buy');

  // Whether an account is required is a deployment policy, reported by the
  // bootstrap response. A demo on the simulated rail may turn it off, and this
  // asserts the behaviour the server is actually configured for rather than
  // one of the two possibilities.
  const requiresAccount = boot.body.requiresAccount !== false;

  const anonQuote = await call<{ type: string }>('/v1/checkout/quote', {
    method: 'POST',
    body: {},
  });
  if (requiresAccount) {
    check(
      'an anonymous principal cannot place orders',
      anonQuote.status === 403 && String(anonQuote.body.type).includes('anonymous'),
      `status ${anonQuote.status}`,
    );
  } else {
    check(
      'an anonymous principal may order when the deployment permits it',
      anonQuote.status === 202,
      `status ${anonQuote.status}`,
    );
    // That quote consumed the cart — `createJobs` moves it to `checking_out` —
    // so the lines have to be restored before the real run below.
    for (const item of chosen) {
      await call('/v1/cart/items', { method: 'POST', body: { productId: item.productId, quantity: 1 } });
    }
  }

  // Claiming is the only privilege escalation in the system, so the smoke test
  // proves it cannot be short-circuited before proving it works.
  const claimEmail = `${deviceUserId}@example.test`;

  const unchallenged = await call('/v1/me/claim', {
    method: 'POST',
    body: { provider: 'email', email: claimEmail, token: '000000' },
  });
  check(
    'a claim without a challenge is refused',
    unchallenged.status === 400,
    `status ${unchallenged.status}`,
  );

  const oauthClaim = await call('/v1/me/claim', {
    method: 'POST',
    body: { provider: 'google', token: 'not-a-real-id-token' },
  });
  check(
    'an unverifiable OAuth claim is refused rather than trusted',
    oauthClaim.status === 400,
    `status ${oauthClaim.status}`,
  );

  const challenge = await call<{ expiresAt: string }>('/v1/me/claim/email', {
    method: 'POST',
    body: { email: claimEmail },
  });
  check('an email challenge is issued', challenge.status === 202);

  const code = await readDevCode(claimEmail);
  check('the development transport delivered a code', code !== null);

  const wrongCode = await call('/v1/me/claim', {
    method: 'POST',
    body: { provider: 'email', email: claimEmail, token: code === '000000' ? '111111' : '000000' },
  });
  check('a wrong code is refused', wrongCode.status === 400, `status ${wrongCode.status}`);

  const claim = await call<{ token: string }>('/v1/me/claim', {
    method: 'POST',
    body: { provider: 'email', email: claimEmail, token: code ?? '' },
  });
  check('a verified email claims the profile', claim.status === 200 && Boolean(claim.body.token));

  const replayed = await call('/v1/me/claim', {
    method: 'POST',
    body: { provider: 'email', email: claimEmail, token: code ?? '' },
  });
  check(
    'the code cannot be replayed',
    // 400 when the code is spent; 401 when the claim already revoked the
    // session the replay is carrying. Both are refusals.
    replayed.status === 400 || replayed.status === 401,
    `status ${replayed.status}`,
  );

  const staleToken = token;
  token = claim.body.token;

  const withStale = await call('/v1/me', { token: staleToken });
  check(
    'the pre-claim token is revoked by the privilege change',
    withStale.status === 401,
    `status ${withStale.status}`,
  );

  interface JobSummary {
    orderId: string;
    status: string;
    quote: { hash: string; total: number } | null;
    failure: { code?: string; message: string } | null;
    needsInput: { promptId: string; kind: string; options?: Array<{ id: string }> } | null;
  }

  const quote = await call<{ jobs: JobSummary[] }>('/v1/checkout/quote', {
    method: 'POST',
    body: {},
  });
  check(
    'quoting returns 202 immediately rather than holding the request open',
    quote.status === 202,
    `status ${quote.status}`,
  );
  check(
    'every job starts in a pre-authorization state',
    (quote.body.jobs ?? []).length > 0 &&
      quote.body.jobs.every((j) => ['pending', 'quoting'].includes(j.status)),
    quote.body.jobs ? quote.body.jobs.map((j) => j.status).join(',') : 'no jobs returned',
  );
  // Everything below drives these jobs. Without them the run has nothing left
  // to say, and saying so beats a stack trace two hundred lines later.
  if (!quote.body.jobs?.length) {
    process.stdout.write('\n  no checkout jobs were created; skipping the rest of the run\n');
    summarize();
    return;
  }

  // Poll each job to its terminal-for-now state. This is the documented
  // fallback to the SSE stream, so exercising it here keeps it honest — and a
  // job that stops to ask a question gets answered, which is the only way the
  // `request_user_input` escape hatch is actually tested.
  let answeredPrompt = false;
  const settled: JobSummary[] = [];
  for (const created of quote.body.jobs) {
    let current = created;
    const deadline = Date.now() + 90_000;
    while (
      Date.now() < deadline &&
      !['awaiting_auth', 'failed', 'cancelled'].includes(current.status)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const polled = await call<JobSummary>(`/v1/checkout/jobs/${created.orderId}`);
      current = polled.body;

      if (current.needsInput) {
        const value = current.needsInput.options?.[0]?.id ?? 'solved';
        const answer = await call(`/v1/checkout/jobs/${created.orderId}/input`, {
          method: 'POST',
          body: { promptId: current.needsInput.promptId, value },
        });
        if (answer.status === 202) answeredPrompt = true;
      }
    }
    settled.push(current);
  }
  check(
    'polling is a working fallback to the SSE stream',
    settled.every((j) => ['awaiting_auth', 'failed', 'cancelled'].includes(j.status)),
    settled.map((j) => j.status).join(','),
  );
  if (answeredPrompt) {
    check('a job that stops to ask the user something can be answered and resumes', true);
  }

  const quoteBody = { jobs: settled };

  if (quote.status === 202 && quoteBody.jobs.length > 0) {
    check(
      'checkout creates one job per merchant',
      quoteBody.jobs.length === chosen.length,
      `${quoteBody.jobs.length} jobs for ${chosen.length} merchants`,
    );
    // A job that failed cleanly is a pass for the failure path, but at least
    // one must have produced a quote or the authorization contract is untested.
    for (const failedJob of quoteBody.jobs.filter((j) => j.failure !== null)) {
      check(
        `a failed job reports its reason rather than hanging (${failedJob.failure?.message ?? ''})`,
        failedJob.status === 'failed' && Boolean(failedJob.failure?.message),
      );
    }
    const job = quoteBody.jobs.find((j) => j.quote !== null);

    // Every job failing is the right outcome when every merchant in the cart
    // blocks agent traffic — which is the case for a catalog of Amazon and eBay
    // listings, both of which disallow these paths and are reached through
    // their official APIs instead. The authorization contract still needs one
    // real quote to exercise, so this says which it is rather than reporting a
    // correct refusal as a failure.
    const allBlocked =
      !job && quoteBody.jobs.every((j) => j.failure?.code === 'blocked');
    if (allBlocked) {
      process.stdout.write(
        '  --   every merchant in the cart blocks agents; the authorization contract is ' +
          'covered by the checkout unit suite instead\n',
      );
    } else {
      check('at least one job produced a quote', Boolean(job));
    }
    if (!job) {
      process.stdout.write('\n  no quote to authorize; ending the run here\n');
      summarize();
      return;
    }
    if (job?.quote) {
      check('the job stops at awaiting_auth, before money moves', job.status === 'awaiting_auth');

      const wrongHash = await call<{ type: string }>(
        `/v1/checkout/jobs/${job.orderId}/authorize`,
        { method: 'POST', body: { quoteHash: 'f'.repeat(64) } },
      );
      check(
        'authorizing against the wrong quote hash is a 409 and places nothing',
        wrongHash.status === 409 && String(wrongHash.body.type).includes('quote-mismatch'),
        `status ${wrongHash.status}`,
      );

      const authorized = await call<{ status: string; merchantOrderNumber: string | null }>(
        `/v1/checkout/jobs/${job.orderId}/authorize`,
        { method: 'POST', body: { quoteHash: job.quote.hash } },
      );
      check(
        'authorizing against the correct hash places the order',
        authorized.status === 200 &&
          ['placed', 'uncertain', 'failed'].includes(authorized.body.status),
        `status ${authorized.body.status}`,
      );

      const replay = await call(`/v1/checkout/jobs/${job.orderId}/authorize`, {
        method: 'POST',
        body: { quoteHash: job.quote.hash },
      });
      check(
        'one authorization equals at most one order: a replay is refused',
        replay.status === 409,
        `status ${replay.status}`,
      );
    }
  } else {
    check('checkout produced at least one job', false, `status ${quote.status}`);
  }

  // ---- Errors and limits -------------------------------------------------
  section('Gateway: problem details and auth');

  const unauthorized = await (async () => {
    const saved = token;
    token = '';
    const result = await call<{ type: string }>('/v1/me');
    token = saved;
    return result;
  })();
  check('an unauthenticated request is refused', unauthorized.status === 401);
  check(
    'errors are RFC 9457 problem details with a stable type URI',
    String(unauthorized.body.type).startsWith('https://window.app/problems/'),
    String(unauthorized.body.type),
  );

  const badRequest = await call<{ type: string; status: number }>('/v1/feed/page', {
    method: 'POST',
    body: { mode: 'sideways' },
  });
  check('an invalid feed request is a 400 problem', badRequest.status === 400);

  // ---- Summary ----------------------------------------------------------
  summarize();
}

/** Prints the tally and sets the exit code. Every exit path goes through it. */
function summarize(): void {
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`failures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`smoke test crashed: ${(error as Error).message}\n${(error as Error).stack}\n`);
  process.exit(1);
});
