# Window

*TikTok for shopping — a discovery-first commerce feed.*

An implementation of the Window PRD: a ranked infinite feed of real, purchasable
listings across new, secondhand and auction supply, with two first-class
layouts, behaviour-driven ranking over vector similarity, and an agentic
checkout layer.

## What runs

```
packages/
  shared/   the wire contract, the taxonomy, the design tokens, the ranking config
  server/   ingestion, ranking, feed, catalog, events, cart, agentic checkout, the /v1 API
  app/      one Expo codebase targeting iOS, Android and web
```

One `ProductCard` type, one `cursorReducer`, one set of ranking weights — the
client and server share them rather than agreeing to keep two copies aligned.

## Running it

Prerequisites: Node 20+, a Supabase project, and npm. The current server uses
Supabase/Postgres as its primary database. Copy the server environment template
and set the Supabase credentials before starting the API:

```bash
cd Window
cp packages/server/.env.example packages/server/.env
# Edit packages/server/.env and set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
npm run build -w @window/shared
```

Start the API and web client in separate terminals:

```bash
# Terminal 1 — API at http://127.0.0.1:4000
npm run dev:server

# Terminal 2 — Expo web at http://localhost:8081
npm run dev:web
```

Wait for `window api listening` before opening the web app. Verify the API with:

```bash
curl -s http://127.0.0.1:4000/health
```

The health response should include `"ok":true`. Do not use the root `npm run
dev` command for the current Supabase setup: it runs the legacy seed process
first, and that process may fail on Supabase's protected delete operations.

`ingest` checks each store's robots.txt, reads the public `/products.json`
feed at 0.5 req/s, fetches each image once and stores it on our own origin.
`--store <domain>`, `--pages N` and `--fresh` narrow or reset it.

For a physical device, start Expo from `packages/app` and use the Metro host
address rather than `localhost`:

```bash
cd packages/app
npx expo start --clear
```

The client derives the development machine's address from Expo unless
`EXPO_PUBLIC_API_URL` is explicitly set.

Verify:

```bash
npm test                              # server unit tests
npm run smoke -w @window/server       # needs a running server
curl -s http://127.0.0.1:4000/health
```

## Development fixture products

To populate the configured Supabase project with four deterministic products,
run the idempotent fixture script from the server package:

```bash
cd Window/packages/server
npx tsx --env-file-if-exists=.env insert-dummy-products.ts
```

The script creates or updates one demo seller and these active products:

- Wireless Bluetooth Headphones
- USB-C Charging Cable (2m, Braided)
- Portable Power Bank 10000mAh
- Adjustable Aluminium Phone Stand

It generates media through the local media pipeline and creates 1024-dimensional
embeddings, so the products can be returned by the feed and displayed by the
web app. Re-running the command is safe.

If onboarding has already completed in a browser, reset its development device
identity in the browser console:

```js
localStorage.removeItem('window.deviceUserId')
location.reload()
```

On native development builds, clear app storage or reinstall the app.

## How the pieces fit

**Ranking** is four stages over the vector index — retrieve 400 candidates by
similarity, filter, score with `w1·sim + w2·q + w3·ctr + w4·f + w5·b − w6·pen`,
then MMR-diversify over L2 and inject the exploration slot. Weights live in a
config document and hot-reload via `POST /internal/ranking/config`.

**Navigation** opens on the 2x2 grid — the shop window. Tapping a tile enlarges
it into the full-bleed card, where scrolling moves through the whole ranked
feed, and Back returns to the pane you came from. Both layouts are one integer
cursor over one buffer; changing layout never fetches a different list. `packages/shared/src/cursor.ts` is a
pure reducer and [`cursor.test.ts`](packages/server/src/ranking/cursor.test.ts)
pins every behaviour the PRD specifies for it, including that the grid does not
shift while you triage all four tiles of a promoted pane.

**Ingestion** runs normalize → gate → classify → embed → cluster → score. The
seeder emits `RawListing`s, the same shape a source adapter produces, so seeding
exercises the real pipeline rather than writing finished documents into the
database.

**Checkout** decomposes one cart into one job per merchant. Quoting is async and
streamed; the job stops at `awaiting_auth` and will not proceed without a tap
that echoes the exact `quoteHash`. A mismatch, an expired quote or a replayed
authorization is a 409 and places nothing.

## Configuration

Set these in `packages/server/.env` unless noted otherwise:

| Variable | Default | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | project URL | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Required by the server and fixture script; keep it private |
| `PUBLIC_URL` | `http://127.0.0.1:4000` | Origin used in generated media URLs |
| `PORT` | `4000` | API port |
| `REDIS_URL` | unset | Falls back to an in-process cache |
| `EXPO_PUBLIC_API_URL` | auto-detected | Client API base; set explicitly for a deployed or device-accessible API |
| `ATLAS_VECTOR_SEARCH` | `0` | Legacy/optional Atlas retrieval flag; local development uses the in-process vector index |
| `REAP_API_KEY` / `REAP_BASE_URL` | unset | Without these, checkout uses the simulated rail |

The application embedding contract is currently **1024 dimensions**. Product
rows with another vector length are not compatible with local ranking.

## What is real, and what is a seam

The PRD describes a system with dependencies this environment does not have.
Rather than fake them, each one is an interface with a working local
implementation and a documented place for the real thing.

**Fully implemented.** The taxonomy (18 / 180 / 1,440). The four-stage ranking
pipeline, MMR, the exploration slot, topic adoption and demotion, the online
EMA user-vector update and daily decay. Cold-start composition. Quad-coherent
Window retrieval. The Bloom seen-set. Normalization, clustering, the quality
gate, the quality score with its review-credibility factor, and the risk model
across all eight signal families with its five enforcement tiers. Review
aggregation, bucketing and attribution. The multi-merchant cart, the checkout
job lifecycle, the coupon store with its learning loop, and the whole `/v1`
surface with RFC 9457 problems, per-principal rate limits and SSE.

**Working local implementation, real adapter behind an interface.**

| Seam | Local | Real |
| --- | --- | --- |
| Vector search | Exhaustive in-process index, same filters and same scalar quantization | `$vectorSearch` on Atlas — available behind config |
| Embeddings | Deterministic 1024-d random-projection feature embedder | Any hosted multimodal provider behind `EmbeddingProvider` |
| Media | Real source images fetched once and served from our origin; synthetic ones generated | A libvips-backed transcoder emitting AVIF/WebP at three widths |
| eBay / Amazon | Web adapters (`AmazonWebAdapter`, `EbayWebAdapter`) reading the storefronts through a primed browser-fingerprint fetch; `npm run ingest:web` crawls them with an agent driven by the `claude` CLI | Official-API adapters still take over when `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` or `AMAZON_ACCESS_KEY`/`AMAZON_SECRET_KEY`/`AMAZON_PARTNER_TAG` are set |
| Cache | In-process TTL map | Redis, via `REDIS_URL` |
| Review summary | Extractive, composed from measured theme statistics, labelled as generated | A hosted model behind `ReviewSummarizer` |
| Checkout | `SimulatedMerchantAgent`, which injects the PRD's failure modes | A Playwright-backed `CheckoutBrowser`, or a protocol client |
| Payments | `SimulatedPaymentRail` enforcing caps, spend rules and one-capture | Reap, behind `PaymentRail` |

The simulated agent and payment rail are named as simulators and never contact a
merchant or move money. `BrowserCheckoutAgent`, `Tier3BrowserAdapter` and
`ReapPaymentRail` refuse loudly when unconfigured rather than returning a
plausible result — a checkout path that pretends to work is the most dangerous
thing this codebase could contain.

**Real supply.** Shopify storefronts are ingested for real over their public
`/products.json` — robots-checked, rate-limited, images fetched once and
re-served from our origin rather than hotlinked. eBay and Amazon are also read
live: web adapters fetch the storefront HTML through a browser-impersonating
helper that primes session cookies first, the browse agent (`claude -p` under
the user's subscription) chooses which pages and items are worth opening, and
eBay discovery additionally walks the BROWSE sitemap index its robots.txt
advertises. `GET /v1/products/:id?live=1` re-fetches a card's source URL on
tap, and the cart's just-in-time check verifies live price and stock. The
official-API adapters (Browse and PA-API 5.0, the latter with a hand-rolled
SigV4 signer verified against the published AWS test vectors) remain the
preferred path whenever credentials exist.

**Not implemented.** Tier-3 crawling needs a browser driver. Protocol-native
checkout (ACP/MPP/TAP) is a defined interface with no client. OAuth token
verification on `/v1/me/claim` is deliberately an obvious hole rather than a
fake check. There is no video in the generated catalog: the pipeline declines
rather than fabricating an HLS manifest that would 404, which is safe precisely
because a card is complete with a still image alone.

## Notable decisions

- **The local vector index is exhaustive, not approximate.** Its recall is an
  upper bound on what Atlas returns. That is the right trade for a development
  catalog and the wrong one above a few million products.
- **Price parsing decides the decimal separator by position.** `1.299,99` and
  `1,299.99` are the same amount; getting it backwards is a 100× error on a card.
- **A brand is never guessed.** Below the 0.9 fuzzy threshold it is left null,
  because a wrong brand feeds affinity, suppression and the counterfeit watchlist.
- **The risk score floors at the caution band on a severe price anomaly.** A
  purely additive ensemble cannot make one family "the strongest signal"; the
  floor makes the PRD's claim true in the output, not just in the feature table.
- **Account deletion unlinks orders rather than deleting them.** They are
  transaction records with their own retention.
- **Classification searches all 1,440 leaves rather than descending the tree.**
  Descending picks an L1 from its own name, and "Tech and gadgets" shares no
  vocabulary with "Mechanical Keyboard 75% Tactile"; the first branch was a coin
  flip and everything under it inherited the mistake. The words that identify a
  product live in the leaves.
- **Confidence is a softmax share damped by absolute agreement.** Relative
  decisiveness alone calls a uniformly-bad field confident; absolute cosine
  alone is a threshold on the embedder's scale rather than on certainty.
