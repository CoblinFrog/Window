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

Prerequisites: Node 20+ and a MongoDB reachable at `MONGO_URL`.

```bash
npm install
npm run build -w @window/shared

# MongoDB, if you don't already have one running
.data/tmp/mongodb-macos-aarch64-8.0.4/bin/mongod \
  --dbpath .data/mongo --port 27017 --bind_ip 127.0.0.1 \
  --logpath .data/logs/mongod.log --fork

npm run seed          # ~12k synthetic products through the real pipeline, ~6 min
npm run ingest -w @window/server   # ~2k REAL listings from public Shopify stores
npm run dev:server    # http://127.0.0.1:4000
npm run dev:web       # http://localhost:8081
```

`ingest` checks each store's robots.txt, reads the public `/products.json`
feed at 0.5 req/s, fetches each image once and stores it on our own origin.
`--store <domain>`, `--pages N` and `--fresh` narrow or reset it.

Verify:

```bash
npm test                              # 120 unit tests
npm run smoke -w @window/server       # 62 end-to-end assertions, needs a running server
curl -s localhost:4000/health
```

`npm run seed -- --count 2000` for a faster catalog.

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

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://127.0.0.1:27017` | Point at Atlas to use real `$vectorSearch` |
| `ATLAS_VECTOR_SEARCH` | `0` | `1` enables the Atlas retrieval path |
| `REDIS_URL` | unset | Falls back to an in-process cache |
| `REAP_API_KEY` / `REAP_BASE_URL` | unset | Without these, checkout uses the simulated rail |
| `EXPO_PUBLIC_API_URL` | `http://127.0.0.1:4000` | API base for the client |

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
| Vector search | Exhaustive in-process index, same filters and same scalar quantization | `$vectorSearch` on Atlas — already written, enabled by config |
| Embeddings | Deterministic 1024-d random-projection feature embedder | Any hosted multimodal provider behind `EmbeddingProvider` |
| Media | Real source images fetched once and served from our origin; synthetic ones generated | A libvips-backed transcoder emitting AVIF/WebP at three widths |
| eBay / Amazon | Official-API adapters that refuse without credentials | Set `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` or `AMAZON_ACCESS_KEY`/`AMAZON_SECRET_KEY`/`AMAZON_PARTNER_TAG` |
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
re-served from our origin rather than hotlinked. eBay and Amazon are reached
through their official APIs (Browse and PA-API 5.0, the latter with a
hand-rolled SigV4 signer verified against the published AWS test vectors); both
refuse loudly without credentials and neither is ever scraped, because both
sites' robots.txt disallow their item and search paths.

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
