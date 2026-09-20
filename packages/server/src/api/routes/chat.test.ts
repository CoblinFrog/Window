import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { ChatResponse } from '@window/shared';
import { chatRoutes } from './chat.js';
import { problemDetails } from '../middleware.js';
import type { AppContext } from '../context.js';
import type { User } from '../../db/supabase-collections.js';

/**
 * The route, exercised over a real socket with everything behind it faked.
 * What this is actually guarding is the wire shape: the panel renders straight
 * off these fields, so a pick that reaches it without a price or a URL is a
 * blank card, and a silent contract change is the way that happens.
 */

const memoryCache = {
  kind: 'memory' as const,
  async incr() {
    return { count: 1, resetAt: Date.now() + 60_000 };
  },
};

/** A context with only what the route touches. */
function fakeContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    cache: memoryCache,
    embedder: {
      version: 'test',
      dimensions: 4,
      embed: async () => [1, 0, 0, 0],
      embedBatch: async (inputs: unknown[]) => inputs.map(() => [1, 0, 0, 0]),
      embedText: async () => [1, 0, 0, 0],
    },
    vectors: { kind: 'local', async search() { return []; }, async size() { return 0; } },
    llm: {
      async decide(prompt: string) {
        if (prompt.includes('intake parser')) {
          return JSON.stringify({ kind: 'shop', item: 'desk lamp', budget: 60 });
        }
        return JSON.stringify({ keep: [1, 2], reply: 'Two good lamps.' });
      },
    },
    // No network: the ask is answered from these two cards.
    askSearch: async () => CARDS,
    ...overrides,
  } as unknown as AppContext;
}

/** Boots the router on an ephemeral port and returns a caller for it. */
async function serve(
  ctx: AppContext,
  user: User | null,
): Promise<{ post: (body: unknown) => Promise<{ status: number; body: any }>; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user !== null) req.currentUser = user;
    next();
  });
  app.use('/v1/chat', chatRoutes(ctx));
  app.use(problemDetails());

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    async post(body: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    close: () => server.close(),
  };
}

const USER = { id: 'u1', interestVector: [1, 0, 0, 0] } as unknown as User;

/** Two priced storefront cards, and one that a card could not be built from. */
const CARDS = [
  {
    storefront: 'amazon.com' as const,
    sourceId: 'A1',
    url: 'https://www.amazon.com/dp/AAAAAAAAAA',
    title: 'Desk lamp one',
    priceMinor: 3999,
    imageUrl: 'https://m.media-amazon.com/images/I/one.jpg',
    rating: 4.5,
    reviewCount: 1200,
  },
  {
    storefront: 'ebay.com' as const,
    sourceId: 'E1',
    url: 'https://www.ebay.com/itm/1',
    title: 'Desk lamp two',
    priceMinor: 2500,
    imageUrl: null,
    rating: null,
    reviewCount: null,
  },
];

describe('POST /v1/chat', () => {
  it('answers with picks the client can render as cards', async () => {
    const ctx = fakeContext();
    const server = await serve(ctx, USER);
    try {
      const { status, body } = await server.post({ message: 'desk lamp under $60', sessionId: 's1' });
      assert.equal(status, 200);

      const reply = body as ChatResponse;
      assert.equal(reply.kind, 'answer');
      assert.equal(reply.budgetMinor, 6000);
      assert.ok(reply.picks.length >= 1);
      for (const pick of reply.picks) {
        // Every field the panel reads must be present and of the right type.
        assert.equal(typeof pick.title, 'string');
        assert.equal(typeof pick.priceMinor, 'number');
        assert.equal(typeof pick.url, 'string');
        assert.equal(typeof pick.currency, 'string');
        assert.ok(Array.isArray(pick.sources));
      }
      // The resolved request survives the wire, since the next turn builds on it.
      assert.equal(typeof reply.standing?.item, 'string');
    } finally {
      server.close();
    }
  });

  it('rejects an empty or oversized message', async () => {
    // `ApiError.validation` is a 400 here, not a 422 — the app's own contract.
    const server = await serve(fakeContext(), USER);
    try {
      assert.equal((await server.post({ message: '', sessionId: 's1' })).status, 400);
      assert.equal(
        (await server.post({ message: 'x'.repeat(401), sessionId: 's1' })).status,
        400,
      );
      assert.equal((await server.post({ message: 'lamp' })).status, 400);
    } finally {
      server.close();
    }
  });

  it('carries the conversation through the wire', async () => {
    let seenPrompt = '';
    const ctx = fakeContext({
      llm: {
        async decide(prompt: string) {
          if (prompt.includes('intake parser')) {
            seenPrompt = prompt;
            return JSON.stringify({ kind: 'shop', item: 'desk lamp', budget: 40 });
          }
          return JSON.stringify({ keep: [1], reply: 'Cheaper ones, then.' });
        },
      },
    } as Partial<AppContext>);
    const server = await serve(ctx, USER);
    try {
      const { status, body } = await server.post({
        message: 'cheaper',
        sessionId: 's1',
        history: [
          { role: 'user', text: 'desk lamp under $60' },
          { role: 'assistant', text: 'Here are three.' },
        ],
        standing: { item: 'desk lamp', budgetMinor: 6000, requirements: [] },
      });
      assert.equal(status, 200);
      // The intake saw both the transcript and what was settled.
      assert.match(seenPrompt, /desk lamp under \$60/);
      assert.match(seenPrompt, /earlier turns settled on/);
      // And the turn hands back a request the next one can build on.
      const reply = body as ChatResponse;
      assert.equal(reply.standing?.item, 'desk lamp');
      assert.equal(reply.standing?.budgetMinor, 4000);
    } finally {
      server.close();
    }
  });

  it('bounds a client-supplied transcript rather than trusting it', async () => {
    const server = await serve(fakeContext(), USER);
    try {
      // An unbounded history is an unbounded prompt, billed per turn.
      const tooMany = Array.from({ length: 21 }, () => ({ role: 'user' as const, text: 'hi' }));
      assert.equal(
        (await server.post({ message: 'lamp', sessionId: 's1', history: tooMany })).status,
        400,
      );
      assert.equal(
        (await server.post({
          message: 'lamp',
          sessionId: 's1',
          standing: { item: 'x'.repeat(201), budgetMinor: null, requirements: [] },
        })).status,
        400,
      );
    } finally {
      server.close();
    }
  });

  it('refuses an unauthenticated ask', async () => {
    const server = await serve(fakeContext(), null);
    try {
      const { status } = await server.post({ message: 'desk lamp', sessionId: 's1' });
      assert.equal(status, 401);
    } finally {
      server.close();
    }
  });

  it('answers for a user who has not onboarded yet', async () => {
    // No interest vector: the agent must steer by the request alone rather
    // than fail, because the panel is reachable before onboarding completes.
    const server = await serve(fakeContext(), { id: 'u2', interestVector: null } as unknown as User);
    try {
      const { status, body } = await server.post({ message: 'desk lamp', sessionId: 's1' });
      assert.equal(status, 200);
      assert.equal((body as ChatResponse).kind, 'answer');
    } finally {
      server.close();
    }
  });
});
