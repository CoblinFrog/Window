import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosine, normalize } from '@window/shared';
import { recommendListings, sessionVector } from './recommend.js';
import type { VectorCandidate, VectorQuery, VectorSearch } from '../vector/types.js';

/** Supabase ids are opaque strings; the tests only need them to be distinct. */
let idCounter = 0;
const nextId = (): string => `product-${(idCounter += 1)}`;

/**
 * A VectorSearch that actually ranks: cosine over a hand-built catalog, so the
 * tests exercise the blend's effect on ordering, not just plumbing.
 */
function fakeIndex(
  catalog: Array<{ title: string; price: number; url: string; embedding: number[]; media?: unknown }>,
  captured?: { query?: VectorQuery },
): VectorSearch {
  return {
    kind: 'local',
    async size() {
      return catalog.length;
    },
    async search(query: VectorQuery): Promise<VectorCandidate[]> {
      if (captured) captured.query = query;
      return catalog
        .map((doc) => ({
          id: nextId(),
          title: doc.title,
          price: { amount: doc.price, currency: 'USD' },
          source: { url: doc.url },
          media: doc.media,
          vectorScore: (cosine(query.vector, doc.embedding) + 1) / 2,
        }))
        .sort((a, b) => b.vectorScore - a.vectorScore)
        .slice(0, query.limit) as unknown as VectorCandidate[];
    },
  };
}

const DIM = 8;
const e = (axis: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
};

describe('sessionVector', () => {
  it('blends preferences and recent by the recent weight', () => {
    const v = sessionVector(e(0), e(1), 0.6);
    assert.ok(Math.abs(cosine(v, e(1)) - 0.832) < 0.01, `recent should lead, got ${v}`);
    assert.ok(Math.abs(cosine(v, e(0)) - 0.555) < 0.01);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, 'result is unit-normalized');
  });

  it('falls through to whichever vector is present', () => {
    assert.deepEqual(sessionVector(e(0), []), normalize(e(0)));
    assert.deepEqual(sessionVector([], e(1), 0.6), normalize(e(1)));
  });
});

describe('recommendListings', () => {
  const catalog = [
    { title: 'Keyboard', price: 12999, url: 'https://www.ebay.com/itm/1', embedding: e(0) },
    { title: 'TV', price: 29995, url: 'https://www.ebay.com/itm/2', embedding: e(1) },
    { title: 'Headphones', price: 19900, url: 'https://www.amazon.com/dp/X', embedding: e(2) },
    { title: 'Monitor', price: 24999, url: 'https://www.amazon.com/dp/Y', embedding: e(3) },
  ];

  it('lets the recent vector steer the ranking when it leads', async () => {
    const recentHeavy = await recommendListings(fakeIndex(catalog), {
      preferences: e(0),
      recent: e(1),
      recentWeight: 0.9,
      limit: 2,
    });
    assert.equal(recentHeavy[0]!.title, 'TV');

    const prefsHeavy = await recommendListings(fakeIndex(catalog), {
      preferences: e(0),
      recent: e(1),
      recentWeight: 0.1,
      limit: 2,
    });
    assert.equal(prefsHeavy[0]!.title, 'Keyboard');
  });

  it('returns the requested page size of mapped listings', async () => {
    const results = await recommendListings(fakeIndex(catalog), {
      preferences: e(0),
      recent: e(1),
      limit: 3,
    });
    assert.equal(results.length, 3);
    const first = results[0]!;
    // Supabase ids are opaque strings rather than Mongo's 24-hex ObjectId;
    // what matters is that the candidate's id is carried through unchanged.
    assert.equal(typeof first.productId, 'string');
    assert.ok(first.productId.length > 0);
    assert.ok(first.score >= results[1]!.score, 'sorted by similarity');
    assert.equal(first.currency, 'USD');
    assert.ok(first.url!.startsWith('https://'));
  });

  it('defaults to in-stock active listings and a feed-band limit', async () => {
    const captured: { query?: VectorQuery } = {};
    await recommendListings(fakeIndex(catalog, captured), {
      preferences: e(0),
      recent: e(1),
    });
    assert.equal(captured.query!.limit, 15);
    assert.equal(captured.query!.filter.inStock, true);
    assert.deepEqual(captured.query!.filter.statusIn, ['active']);
  });

  it('sends the blended unit vector to the index', async () => {
    const captured: { query?: VectorQuery } = {};
    await recommendListings(fakeIndex(catalog, captured), {
      preferences: e(0),
      recent: e(1),
      recentWeight: 0.6,
    });
    const expected = sessionVector(e(0), e(1), 0.6);
    assert.deepEqual(captured.query!.vector, expected);
  });

  it('merges web listings and lets their score outrank the catalog', async () => {
    const webListing = {
      sourceDomain: 'amazon.com',
      sourceId: 'B00WEB0001',
      url: 'https://www.amazon.com/dp/B00WEB0001',
      title: 'Fresh keyboard',
      brand: 'Keychron',
      priceAmountMinor: 8999,
      currency: 'USD',
    } as unknown as import('../ingestion/types.js').RawListing;
    const embedder = {
      version: 'test',
      dimensions: DIM,
      embed: async () => e(0),
      embedBatch: async (inputs: unknown[]) => inputs.map(() => e(0)),
      // Embedder maps the web listing's text to exactly the blended direction.
      embedText: async () => [0.5, 0.5, 0, 0, 0, 0, 0, 0],
    };

    const results = await recommendListings(fakeIndex(catalog), {
      preferences: e(0),
      recent: e(1),
      recentWeight: 0.5,
      limit: 4,
    }, {
      web: async () => [webListing],
      embedder,
    });

    const fresh = results.find((r) => r.origin === 'web');
    assert.ok(fresh !== undefined, 'web listing should appear in the page');
    assert.equal(fresh.productId, 'web:amazon.com:B00WEB0001');
    assert.equal(fresh.title, 'Fresh keyboard');
    assert.equal(fresh.score, 1);
    assert.equal(results[0], fresh, 'a perfect web match outranks catalog hits');
  });

  it('carries the main image: hero for catalog rows, first gallery image for web', async () => {
    const withMedia = [
      {
        title: 'Keyboard',
        price: 12999,
        url: 'https://www.ebay.com/itm/1',
        embedding: e(0),
        media: {
          hero: {
            avif: ['https://cdn/h480.avif', 'https://cdn/h1080.avif'],
            webp: ['https://cdn/h480.webp'],
            width: 1080,
            height: 800,
            blurhash: 'x',
          },
          gallery: [],
          video: null,
        },
      },
    ];
    const [stored] = await recommendListings(fakeIndex(withMedia), {
      preferences: e(0),
      recent: e(0),
      limit: 1,
    });
    assert.equal(stored!.imageUrl, 'https://cdn/h1080.avif');

    const web = {
      sourceDomain: 'ebay.com',
      sourceId: '9',
      url: 'https://www.ebay.com/itm/9',
      title: 'Fresh',
      priceAmountMinor: 100,
      currency: 'USD',
      images: [
        { url: 'https://img/hero.jpg', width: 0, height: 0 },
        { url: 'https://img/alt.jpg', width: 0, height: 0 },
      ],
    } as unknown as import('../ingestion/types.js').RawListing;
    const [fresh] = await recommendListings(
      fakeIndex([]),
      { preferences: e(0), recent: e(0), limit: 5 },
      { web: async () => [web] },
    );
    assert.equal(fresh!.imageUrl, 'https://img/hero.jpg');

    const [bare] = await recommendListings(fakeIndex(catalog), {
      preferences: e(0),
      recent: e(0),
      limit: 1,
    });
    assert.equal(bare!.imageUrl, null, 'rows without media get a null image');
  });

  it('dedupes a web re-fetch against the stale catalog row for the same url', async () => {
    const refetched = {
      sourceDomain: 'ebay.com',
      sourceId: '2',
      url: 'https://www.ebay.com/itm/2', // same url as the catalog 'TV' row
      title: 'TV (fresh price)',
      priceAmountMinor: 19995,
      currency: 'USD',
    } as unknown as import('../ingestion/types.js').RawListing;

    const results = await recommendListings(fakeIndex(catalog), {
      preferences: e(1),
      recent: e(1),
      recentWeight: 0.5,
      limit: 10,
    }, { web: async () => [refetched] });

    const rows = results.filter((r) => r.url === 'https://www.ebay.com/itm/2');
    assert.equal(rows.length, 1, 'one row per source url');
    assert.equal(rows[0]!.origin, 'web');
    assert.equal(rows[0]!.price, 19995);
  });
});
