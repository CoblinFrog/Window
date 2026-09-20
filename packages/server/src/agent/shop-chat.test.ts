import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chat, type ChatDeps, type StandingIntent } from './shop-chat.js';
import type { AgentLlm } from './llm.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { StorefrontCard } from '../feed/storefront-search.js';

const DIM = 8;
const e = (axis: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
};

/**
 * An LLM that answers the intake prompt from a script and the combined
 * judge-and-compose prompt by doing the model's real job: keep every numbered
 * row whose title isn't a "Switches" accessory, and write a fixed sentence.
 */
function fakeLlm(intentJson: string, reply = 'Here are your picks.'): AgentLlm {
  return {
    async decide(prompt: string): Promise<string> {
      if (prompt.includes('intake parser')) return intentJson;
      if (prompt.includes('"keep"')) {
        const keep: number[] = [];
        for (const line of prompt.split('\n')) {
          const m = /^(\d+)\.\s/.exec(line);
          if (m !== null && !line.includes('Switches')) keep.push(Number(m[1]));
        }
        return JSON.stringify({ keep, reply });
      }
      return reply;
    },
  };
}

const failingLlm: AgentLlm = {
  async decide(): Promise<string> {
    throw new Error('llm down');
  },
};

function fakeEmbedder(): EmbeddingProvider {
  return {
    version: 'test',
    dimensions: DIM,
    embed: async () => e(0),
    embedBatch: async (inputs: unknown[]) => inputs.map(() => e(0)),
    // Anything mentioning "keyboard" points along axis 0; everything else axis 1.
    embedText: async (text: string) => (text.toLowerCase().includes('keyboard') ? e(0) : e(1)),
  };
}

function card(overrides: Partial<StorefrontCard> = {}): StorefrontCard {
  return {
    storefront: 'amazon.com',
    sourceId: 'B00WEB0001',
    url: 'https://www.amazon.com/dp/B00WEB0001',
    title: 'Fresh keyboard',
    priceMinor: 4999,
    imageUrl: 'https://img/hero.jpg',
    rating: null,
    reviewCount: null,
    ...overrides,
  };
}

/** Two in-budget keyboards — enough to clear the 2-pick floor. */
const TWO_KEYBOARDS: StorefrontCard[] = [
  card({ sourceId: 'k1', url: 'https://www.ebay.com/itm/a', title: 'Keyboard A', storefront: 'ebay.com', priceMinor: 5999 }),
  card({ sourceId: 'k2', url: 'https://www.ebay.com/itm/b', title: 'Keyboard B', storefront: 'ebay.com', priceMinor: 6999 }),
];

const SHOP_INTENT = JSON.stringify({ kind: 'shop', item: 'mechanical keyboard', budget: 80 });
const SESSION = { preferences: e(2) };

const search = (cards: StorefrontCard[]): ChatDeps['search'] => async () => cards;

describe('shop chat', () => {
  it('answers a shopping request with picks inside the stated budget', async () => {
    const deps: ChatDeps = {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([...TWO_KEYBOARDS, card()]),
    };
    const reply = await chat('find me a mechanical keyboard under $80', SESSION, deps);
    assert.equal(reply.kind, 'answer');
    assert.ok(reply.picks.length >= 2 && reply.picks.length <= 5);
    for (const pick of reply.picks) {
      assert.ok(pick.price !== null && pick.price <= 8000, `${pick.title} over budget`);
      assert.ok(pick.url !== null);
    }
    assert.equal(reply.budgetMinor, 8000);
    assert.equal(reply.message, 'Here are your picks.');
  });

  it('renders item cards from the search page alone — image, price, link', async () => {
    const reply = await chat('find me a mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        card({ rating: 4.4, reviewCount: 2248 }),
        card({
          storefront: 'ebay.com',
          sourceId: 'e1',
          url: 'https://www.ebay.com/itm/e1',
          title: 'Ebay keyboard',
          priceMinor: 3999,
          imageUrl: 'https://i.ebayimg.com/x.jpg',
        }),
      ]),
    });
    const amazon = reply.picks.find((p) => p.title === 'Fresh keyboard');
    const ebay = reply.picks.find((p) => p.title === 'Ebay keyboard');
    assert.equal(amazon?.imageUrl, 'https://img/hero.jpg');
    assert.equal(amazon?.sourceDomain, 'amazon.com');
    assert.equal(amazon?.reviewNote, '4.4★ across 2,248 ratings');
    assert.deepEqual(amazon?.sources, [
      { title: 'Ratings on amazon.com', url: 'https://www.amazon.com/dp/B00WEB0001' },
    ]);
    assert.equal(ebay?.imageUrl, 'https://i.ebayimg.com/x.jpg');
    assert.equal(ebay?.price, 3999);
    // eBay cards carry no star rating — no evidence is reported as none.
    assert.equal(ebay?.reviewNote, null);
    assert.deepEqual(ebay?.sources, []);
  });

  it('drops a card over budget even though the storefront was asked to filter', async () => {
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        ...TWO_KEYBOARDS,
        card({ sourceId: 'pricey', url: 'https://www.amazon.com/dp/PRICEY', title: 'Pricey keyboard', priceMinor: 12000 }),
      ]),
    });
    assert.ok(reply.picks.every((p) => p.title !== 'Pricey keyboard'), 'over-budget pick must be cut');
    assert.ok(reply.picks.length >= 2);
  });

  it('cuts a card with no price, since the reply has nothing to quote', async () => {
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        ...TWO_KEYBOARDS,
        card({ sourceId: 'np', url: 'https://www.amazon.com/dp/NOPRICE', title: 'Unpriced keyboard', priceMinor: null }),
      ]),
    });
    const titles = reply.picks.map((p) => p.title);
    assert.ok(!titles.includes('Unpriced keyboard'));
    assert.ok(reply.picks.every((p) => p.price !== null));
  });

  it('cuts a badly-rated product but keeps an unproven one', async () => {
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        // 2.1 stars over 400 ratings: the market has spoken.
        card({ sourceId: 'bad', url: 'https://www.amazon.com/dp/BADRATED01', title: 'Junk keyboard', rating: 2.1, reviewCount: 400 }),
        // Same stars, three ratings: nobody has reviewed it yet, not a verdict.
        card({ sourceId: 'new', url: 'https://www.amazon.com/dp/NEWLISTING', title: 'Unproven keyboard', rating: 2.1, reviewCount: 3 }),
      ]),
    });
    const titles = reply.picks.map((p) => p.title);
    assert.ok(!titles.includes('Junk keyboard'), 'a believable bad average is cut');
    assert.ok(titles.includes('Unproven keyboard'), 'a thin average is not a verdict');
  });

  it('refuses to retrieve from anywhere but Amazon and eBay', async () => {
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      // A third-party storefront and a lookalike domain, as if the search leg
      // were ever persuaded to return one.
      search: search([
        ...TWO_KEYBOARDS,
        card({ sourceId: 'w', url: 'https://www.walmart.com/ip/1', title: 'Walmart keyboard' }),
        card({ sourceId: 'l', url: 'https://amazon.evil.com/dp/X', title: 'Lookalike keyboard' }),
      ]),
    });
    const titles = reply.picks.map((p) => p.title);
    assert.ok(!titles.includes('Walmart keyboard'), 'off-storefront row cut');
    assert.ok(!titles.includes('Lookalike keyboard'), 'lookalike domain cut');
    assert.ok(reply.picks.every((p) => ['amazon.com', 'ebay.com'].includes(p.sourceDomain ?? '')));
  });

  it('answers from the storefronts alone', async () => {
    const reply = await chat('find me a mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        card(),
        card({ sourceId: 'two', url: 'https://www.amazon.com/dp/B00WEB0002', title: 'Second keyboard' }),
      ]),
    });
    assert.equal(reply.kind, 'answer');
    assert.equal(reply.picks.length, 2);
    assert.ok(reply.picks.every((p) => p.origin === 'web'));
  });

  it('says it found nothing when the storefront leg throws', async () => {
    // There is no second source to fall back to, and that is deliberate: the
    // alternative was substituting whatever the catalog had nearest, which is
    // how "budget gaming chair" came back as a keyboard and two smart watches.
    const reply = await chat('find me a mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: async () => {
        throw new Error('amazon gated us');
      },
    });
    assert.equal(reply.kind, 'answer');
    assert.equal(reply.picks.length, 0);
    assert.match(reply.message, /couldn't find/);
  });

  it('pushes the budget into the retrieval call rather than filtering after', async () => {
    const seen: Array<{ query: string; budget: number | null; limit: number }> = [];
    await chat('find me a quiet mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(
        JSON.stringify({
          kind: 'shop',
          item: 'mechanical keyboard',
          budget: 80,
          requirements: ['quiet'],
        }),
      ),
      embedder: fakeEmbedder(),
      search: async (query, budget, limit) => {
        seen.push({ query, budget, limit });
        return [card()];
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.budget, 8000);
    // The requirement narrows the search box query, not just the later filter.
    assert.match(seen[0]!.query, /mechanical keyboard/);
    assert.match(seen[0]!.query, /quiet/);
  });

  it('refuses a non-shopping message without retrieving anything', async () => {
    let searched = false;
    const reply = await chat('what is the capital of France?', SESSION, {
      llm: fakeLlm(JSON.stringify({ kind: 'refused', reply: 'I only help find products.' })),
      embedder: fakeEmbedder(),
      search: async () => {
        searched = true;
        return [];
      },
    });
    assert.equal(reply.kind, 'refused');
    assert.equal(reply.picks.length, 0);
    assert.match(reply.message, /products/);
    assert.equal(searched, false, 'a refused turn costs no fetches');
  });

  it('asks a clarifying question when the request is too vague', async () => {
    const reply = await chat('get me something', SESSION, {
      llm: fakeLlm(JSON.stringify({ kind: 'clarify', reply: 'What kind of item are you after?' })),
      embedder: fakeEmbedder(),
      search: search([]),
    });
    assert.equal(reply.kind, 'clarify');
    assert.equal(reply.picks.length, 0);
  });

  it('survives an LLM outage via the regex fallback', async () => {
    const reply = await chat('find me a mechanical keyboard under $80', SESSION, {
      llm: failingLlm,
      embedder: fakeEmbedder(),
      search: search([...TWO_KEYBOARDS, card()]),
    });
    // The fallback parses the item but judge-and-compose also fails → the
    // gated picks stand and the message is templated.
    assert.equal(reply.kind, 'answer');
    assert.equal(reply.budgetMinor, 8000);
    assert.ok(reply.picks.length >= 2);
    assert.match(reply.message, /mechanical keyboard listings/);
    assert.match(reply.message, /Best match/);
    // A templated message is a sentence, not a dumped storefront title.
    assert.ok(reply.message.length < 140, reply.message);
  });

  it('cuts accessories and parts that are not the item itself', async () => {
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([
        ...TWO_KEYBOARDS,
        card({
          sourceId: 'SW',
          url: 'https://www.amazon.com/dp/B0SWITCH01',
          title: '50 PCS Blue Clicky Mechanical Keyboard Switches',
          priceMinor: 699,
        }),
      ]),
    });
    assert.ok(
      reply.picks.every((p) => !p.title.includes('Switches')),
      'accessory cut by the judge',
    );
    assert.equal(reply.picks.length, 2);
  });

  it('ignores a judge verdict that would empty the answer', async () => {
    const paranoid: AgentLlm = {
      async decide(prompt: string): Promise<string> {
        if (prompt.includes('intake parser')) return SHOP_INTENT;
        return JSON.stringify({ keep: [], reply: 'Nothing qualifies.' });
      },
    };
    const reply = await chat('mechanical keyboard under $80', SESSION, {
      llm: paranoid,
      embedder: fakeEmbedder(),
      search: search([...TWO_KEYBOARDS, card()]),
    });
    assert.ok(reply.picks.length >= 2, 'a working pipeline is not zeroed by one verdict');
    // The prose was written about a verdict we overrode, so it is not used:
    // "Nothing qualifies." above two cards contradicts the cards.
    assert.doesNotMatch(reply.message, /Nothing qualifies/);
    assert.match(reply.message, /Best match/);
  });

  it('does not answer with the catalog\'s nearest miss when the storefronts come back empty', async () => {
    // The reported bug: "mechanical keyboard under $50" answered with night
    // lights. Both storefronts failed, so the pool was catalog-only, and the
    // catalog's nearest neighbours to a lighting-heavy taste vector are lamps.
    // The judge rejected every one of them — correctly — and the answer showed
    // them anyway, because too few survived to clear the floor.
    const lampLover = { preferences: e(1) };
    const reply = await chat('mechanical keyboard under $50', lampLover, {
      llm: fakeLlm(JSON.stringify({ kind: 'shop', item: 'mechanical keyboard', budget: 50 })),
      embedder: fakeEmbedder(),
      // The storefront returned near-misses rather than nothing: a keyword
      // search for a niche item drags in whatever shares its aisle.
      search: async () => [
        card({ sourceId: 'n1', url: 'https://www.ebay.com/itm/n1', title: 'Sunset night light', storefront: 'ebay.com', priceMinor: 1999 }),
        card({ sourceId: 'n2', url: 'https://www.ebay.com/itm/n2', title: 'Moon night light', storefront: 'ebay.com', priceMinor: 2499 }),
        card({ sourceId: 'n3', url: 'https://www.ebay.com/itm/n3', title: 'Star projector night light', storefront: 'ebay.com', priceMinor: 2999 }),
      ],
    });
    assert.ok(
      reply.picks.every((p) => !/night light/i.test(p.title)),
      `answered with ${reply.picks.map((p) => p.title).join(', ')}`,
    );
    assert.equal(reply.picks.length, 0);
    assert.match(reply.message, /couldn't find/);
  });

  describe('conversation', () => {
    const KEYBOARD: StandingIntent = {
      item: 'mechanical keyboard',
      budgetMinor: 8000,
      requirements: [],
    };

    /** Records what the retrieval leg was actually asked for. */
    function spyingSearch(): {
      seen: Array<{ query: string; budget: number | null }>;
      search: NonNullable<ChatDeps['search']>;
    } {
      const seen: Array<{ query: string; budget: number | null }> = [];
      return {
        seen,
        search: async (query, budget) => {
          seen.push({ query, budget });
          return [
            card(),
            card({
              sourceId: 'two',
              url: 'https://www.amazon.com/dp/B00WEB0002',
              title: 'Second keyboard',
            }),
          ];
        },
      };
    }

    it('resolves a bare refinement against the settled request', async () => {
      // "under $50" names no product. It is the settled keyboard, cheaper —
      // and this has to hold on the regex path too, since a dead model must
      // not turn a follow-up into "tell me what you are looking for".
      const leg = spyingSearch();
      const reply = await chat(
        'under $50',
        { ...SESSION, standing: KEYBOARD, history: [{ role: 'user', text: 'mechanical keyboard' }] },
        { llm: failingLlm, embedder: fakeEmbedder(), search: leg.search },
      );
      assert.equal(reply.kind, 'answer');
      assert.equal(leg.seen.length, 1);
      assert.match(leg.seen[0]!.query, /mechanical keyboard/);
      assert.equal(leg.seen[0]!.budget, 5000, 'the new ceiling replaced the old one');
      assert.equal(reply.standing?.item, 'mechanical keyboard');
      assert.equal(reply.standing?.budgetMinor, 5000);
    });

    it('carries requirements forward and adds the new one', async () => {
      const leg = spyingSearch();
      const reply = await chat(
        'make it white',
        {
          ...SESSION,
          standing: { ...KEYBOARD, requirements: ['wireless'] },
          history: [{ role: 'user', text: 'wireless mechanical keyboard' }],
        },
        { llm: failingLlm, embedder: fakeEmbedder(), search: leg.search },
      );
      assert.deepEqual(reply.requirements.sort(), ['white', 'wireless']);
      assert.equal(reply.budgetMinor, 8000, 'the settled budget still applies');
      assert.match(leg.seen[0]!.query, /white/);
    });

    it('does not carry a budget onto a different product', async () => {
      // A ceiling the shopper set for a keyboard is not one they set for a
      // mouse. Applying it silently hides a filter they never asked for.
      const leg = spyingSearch();
      const reply = await chat(
        'find me a mouse',
        { ...SESSION, standing: KEYBOARD, history: [{ role: 'user', text: 'mechanical keyboard' }] },
        { llm: failingLlm, embedder: fakeEmbedder(), search: leg.search },
      );
      assert.equal(reply.standing?.item.includes('mouse'), true);
      assert.equal(reply.budgetMinor, null);
      assert.equal(leg.seen[0]!.budget, null);
    });

    it('keeps the item while asking about an impossible budget', async () => {
      const reply = await chat(
        'under $0.10',
        { ...SESSION, standing: KEYBOARD, history: [{ role: 'user', text: 'mechanical keyboard' }] },
        { llm: failingLlm, embedder: fakeEmbedder(), search: async () => [] },
      );
      assert.equal(reply.kind, 'clarify');
      assert.match(reply.message, /price range/);
      // The thread is not lost: their answer lands on the keyboard again.
      assert.equal(reply.standing?.item, 'mechanical keyboard');
    });

    it('shows the intake the transcript and what was settled', async () => {
      let seenPrompt = '';
      const llm: AgentLlm = {
        async decide(prompt: string): Promise<string> {
          if (prompt.includes('intake parser')) {
            seenPrompt = prompt;
            return JSON.stringify({ kind: 'shop', item: 'mechanical keyboard', budget: 50 });
          }
          return JSON.stringify({ keep: [1, 2], reply: 'Cheaper ones, then.' });
        },
      };
      const reply = await chat(
        'cheaper',
        {
          ...SESSION,
          standing: KEYBOARD,
          history: [
            { role: 'user', text: 'mechanical keyboard under $80' },
            { role: 'assistant', text: 'Here are five.' },
          ],
        },
        { llm, embedder: fakeEmbedder(), search: spyingSearch().search },
      );
      assert.match(seenPrompt, /Conversation so far/);
      assert.match(seenPrompt, /mechanical keyboard under \$80/);
      assert.match(seenPrompt, /earlier turns settled on/);
      assert.equal(reply.message, 'Cheaper ones, then.');
    });

    it('believes a newly named product over a model that carried the old one', async () => {
      // The reported bug: "udget gaming chair" mid-keyboard-conversation came
      // back as keyboards. The intake was told to resolve against the
      // conversation and leaned on it, keeping the settled item even though the
      // message plainly named a different product — typo and all.
      const carriesTheOldItem: AgentLlm = {
        async decide(prompt: string): Promise<string> {
          if (prompt.includes('intake parser')) {
            return JSON.stringify({ kind: 'shop', item: 'mechanical keyboard', budget: 80 });
          }
          return JSON.stringify({ keep: [1, 2], reply: 'Here you go.' });
        },
      };
      const leg = spyingSearch();
      const reply = await chat(
        'udget gaming chair',
        { ...SESSION, standing: KEYBOARD, history: [{ role: 'user', text: 'mechanical keyboard under $80' }] },
        { llm: carriesTheOldItem, embedder: fakeEmbedder(), search: leg.search },
      );
      assert.match(leg.seen[0]!.query, /gaming chair/, 'searched for what they typed');
      assert.doesNotMatch(leg.seen[0]!.query, /keyboard/);
      assert.match(reply.standing?.item ?? '', /gaming chair/);
      // A ceiling set for a keyboard is not one they set for a chair.
      assert.equal(reply.budgetMinor, null);
    });

    it('still lets a genuine refinement keep the settled item', async () => {
      // The guard must fire on zero overlap only, or every "cheaper" becomes a
      // brand-new search and the conversation stops meaning anything.
      const leg = spyingSearch();
      const llm: AgentLlm = {
        async decide(prompt: string): Promise<string> {
          if (prompt.includes('intake parser')) {
            return JSON.stringify({ kind: 'shop', item: 'mechanical keyboard', budget: 50 });
          }
          return JSON.stringify({ keep: [1, 2], reply: 'Cheaper ones, then.' });
        },
      };
      for (const message of ['cheaper', 'in white', 'make it wireless', 'under $50']) {
        const reply = await chat(
          message,
          { ...SESSION, standing: KEYBOARD, history: [{ role: 'user', text: 'mechanical keyboard' }] },
          { llm, embedder: fakeEmbedder(), search: leg.search },
        );
        assert.equal(reply.standing?.item, 'mechanical keyboard', `"${message}" started a new search`);
      }
    });

    it('starts clean when there is no history to resolve against', async () => {
      const reply = await chat('under $50', SESSION, {
        llm: failingLlm,
        embedder: fakeEmbedder(),
        search: async () => [],
      });
      // Nothing settled and no product named: this is not a search.
      assert.notEqual(reply.kind, 'answer');
      assert.equal(reply.standing, null);
    });
  });

  it('keeps picks at 2–5 and reports honestly when the pool runs dry', async () => {
    const one = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([card({ sourceId: 'one', title: 'Only one keyboard' })]),
    });
    assert.equal(one.kind, 'answer');
    assert.equal(one.picks.length, 1);
    assert.match(one.message, /Only found one/);

    const none = await chat('mechanical keyboard under $80', SESSION, {
      llm: fakeLlm(SHOP_INTENT),
      embedder: fakeEmbedder(),
      search: search([]),
    });
    assert.equal(none.picks.length, 0);
    assert.match(none.message, /couldn't find/);
    assert.match(none.message, /Amazon or eBay/);
  });
});
