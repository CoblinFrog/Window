import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropicApi, agentLlm, hasApiCredentials } from './llm-api.js';

/**
 * The client is injected, so none of this touches the network. What is being
 * guarded is the seam the rest of the agent depends on: `decide` returns the
 * answer text and nothing else, and anything that is not an answer — a refusal,
 * an API error — throws, because every caller treats a throw as "the model did
 * not answer" and falls back to its own path.
 */

/** A stand-in for the SDK client, recording what it was asked for. */
function fakeClient(
  reply: Partial<Anthropic.Message> | Error,
  seen: { request?: Record<string, unknown> } = {},
): Anthropic {
  return {
    messages: {
      async create(request: Record<string, unknown>) {
        seen.request = request;
        if (reply instanceof Error) throw reply;
        return {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          ...reply,
        };
      },
    },
  } as unknown as Anthropic;
}

const textBlock = (text: string): Anthropic.TextBlock =>
  ({ type: 'text', text, citations: null }) as Anthropic.TextBlock;

describe('anthropicApi', () => {
  it('returns the answer text, joined across blocks', async () => {
    const llm = anthropicApi({
      client: fakeClient({ content: [textBlock('{"kind":'), textBlock('"shop"}')] }),
    });
    assert.equal(await llm.decide('hi'), '{"kind":"shop"}');
  });

  it('ignores blocks that are not text', async () => {
    // A thinking block is not an answer, and concatenating it into one would
    // put reasoning where the caller expects JSON.
    const llm = anthropicApi({
      client: fakeClient({
        content: [
          { type: 'thinking', thinking: 'hmm', signature: '' } as unknown as Anthropic.ContentBlock,
          textBlock('the answer'),
        ],
      }),
    });
    assert.equal(await llm.decide('hi'), 'the answer');
  });

  it('sends a small output cap and no thinking', async () => {
    const seen: { request?: Record<string, unknown> } = {};
    await anthropicApi({ client: fakeClient({ content: [textBlock('ok')] }, seen) }).decide('hi');
    assert.equal(seen.request?.model, 'claude-haiku-4-5');
    assert.equal(seen.request?.max_tokens, 1024);
    // Haiku rejects output_config.effort outright, so it must not be sent
    // unless a caller opts in alongside a model that takes it.
    assert.equal(seen.request?.output_config, undefined);
    assert.equal(seen.request?.thinking, undefined);
  });

  it('sends effort only when asked for', async () => {
    const seen: { request?: Record<string, unknown> } = {};
    await anthropicApi({
      model: 'claude-opus-5',
      effort: 'low',
      client: fakeClient({ content: [textBlock('ok')] }, seen),
    }).decide('hi');
    assert.deepEqual(seen.request?.output_config, { effort: 'low' });
  });

  it('treats a refusal as no answer', async () => {
    // A refusal is an HTTP 200 with unusable content. Returning its text would
    // hand the intake parser prose where it expects JSON.
    const llm = anthropicApi({
      client: fakeClient({ content: [textBlock('I cannot help')], stop_reason: 'refusal' }),
    });
    await assert.rejects(() => llm.decide('hi'), /declined/);
  });

  it('lets an API failure through so the caller can fall back', async () => {
    const llm = anthropicApi({ client: fakeClient(new Error('503 overloaded')) });
    await assert.rejects(() => llm.decide('hi'), /overloaded/);
  });
});

describe('agentLlm', () => {
  it('uses the API when a credential is configured, the CLI when not', async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    const token = process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      assert.equal(hasApiCredentials(), false);
      // Both shapes satisfy the same interface; only the transport differs.
      assert.equal(typeof agentLlm().decide, 'function');

      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      assert.equal(hasApiCredentials(), true);
      assert.equal(typeof agentLlm().decide, 'function');
    } finally {
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
      if (token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = token;
    }
  });
});
