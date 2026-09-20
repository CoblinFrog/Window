/**
 * The decision-maker, over the Messages API.
 *
 * The CLI path (`llm.ts`) spawns a `claude` subprocess per call. That is fine
 * for a crawl running in the background and far too slow for a chat: the
 * process start, MCP handshake and tool setup dominate, and a shopping turn
 * that should take three seconds took thirty. This talks to the API directly
 * over a kept-alive HTTPS connection, which removes all of it.
 *
 * The trade is credentials. The CLI runs under the user's Claude subscription
 * with no API key at all; this needs one, billed separately. So it is not a
 * replacement — `agentLlm()` picks this when credentials exist and falls back
 * to the CLI when they do not, and both satisfy the same one-method interface.
 *
 * Everything here is tuned for one shape of call: a short prompt in, a short
 * JSON or two-sentence answer out, as fast as possible. No thinking, a small
 * output cap, and a timeout the caller can actually wait out.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { claudeCli, type AgentLlm, type ClaudeCliOptions } from './llm.js';

const log = logger.child('agent.llm.api');

/**
 * Default model. The project asked for Haiku, and these calls are a structured
 * extraction and a short piece of prose — the cheapest current model is the
 * right size for both. `AGENT_LLM_MODEL` overrides it, and `claude-opus-5` is
 * the upgrade when instruction-following matters more than latency.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Output cap. Deliberately small: every call here returns either a one-line
 * JSON object or two or three sentences, and a large cap on a non-streaming
 * request only buys the chance to sit through a runaway generation.
 */
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicApiOptions {
  /** Model id. Defaults to `AGENT_LLM_MODEL`, else Haiku 4.5. */
  model?: string;
  /** Output cap. Default 1024 — enough for JSON plus a short reply. */
  maxTokens?: number;
  /** Wall-clock ceiling for one call, in milliseconds. */
  timeoutMs?: number;
  /**
   * Reasoning effort, for models that take it. Left unset by default because
   * Haiku 4.5 rejects `output_config.effort` outright — set it only alongside
   * a model that supports it, such as `claude-opus-5`.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Injectable for tests. Defaults to a client built from the environment. */
  client?: Anthropic;
}

/**
 * True when the SDK has something to authenticate with. The SDK resolves an
 * API key, then an auth token, then a stored CLI profile, so this checks the
 * env vars it reads rather than trying to construct a client and catching.
 */
export function hasApiCredentials(): boolean {
  return (
    (process.env.ANTHROPIC_API_KEY ?? '') !== '' ||
    (process.env.ANTHROPIC_AUTH_TOKEN ?? '') !== ''
  );
}

export function anthropicApi(options: AnthropicApiOptions = {}): AgentLlm {
  const model = options.model ?? process.env.AGENT_LLM_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // The TypeScript SDK counts this in milliseconds, unlike the Python one.
  // It already retries 429s and 5xx twice, so the wall clock can reach three
  // times this — the caller's own deadline is what actually bounds the turn.
  const timeout = options.timeoutMs ?? 20_000;
  const client = options.client ?? new Anthropic({ timeout });

  return {
    async decide(prompt: string): Promise<string> {
      const started = Date.now();
      try {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          // No `thinking`: on Haiku that means none, which is what a JSON
          // extraction wants. A model where thinking is on by default gets it
          // dialled down through `effort` instead of switched off, because
          // disabling it outright makes some models narrate tool calls in
          // prose rather than emit them.
          ...(options.effort !== undefined
            ? { output_config: { effort: options.effort } }
            : {}),
          messages: [{ role: 'user', content: prompt }],
        });

        // `content` is a union; only text blocks carry an answer.
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();

        log.debug('api call', {
          model,
          ms: Date.now() - started,
          stopReason: response.stop_reason,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        });

        // A refusal is a 200 with no usable answer, so it has to be checked
        // before the text is trusted. Callers already treat a throw as "the
        // model did not answer" and fall back, which is the right handling.
        if (response.stop_reason === 'refusal') {
          throw new Error('the model declined this request');
        }
        return text;
      } catch (error) {
        // Most specific first: a bad key or a bad request will never succeed on
        // retry and should be loud, while a rate limit or an overloaded API is
        // the ordinary weather this path runs in.
        if (error instanceof Anthropic.AuthenticationError) {
          log.error('anthropic auth failed — check ANTHROPIC_API_KEY', { model });
        } else if (error instanceof Anthropic.BadRequestError) {
          log.error('anthropic rejected the request', { model, error: error.message });
        } else if (error instanceof Anthropic.RateLimitError) {
          log.warn('anthropic rate limited', { model });
        } else if (error instanceof Anthropic.APIError) {
          log.warn('anthropic call failed', { model, status: error.status });
        }
        throw error;
      }
    },
  };
}

/**
 * The decision-maker the app should use.
 *
 * Prefers the API, because on a chat turn the subprocess the CLI spawns costs
 * more than the model does. Falls back to the CLI when no API credentials are
 * configured, so a checkout with no key set still works — just slowly, which
 * the log line says plainly rather than leaving someone to wonder why a reply
 * takes half a minute.
 */
export function agentLlm(
  options: AnthropicApiOptions & { cli?: ClaudeCliOptions } = {},
): AgentLlm {
  if (hasApiCredentials()) return anthropicApi(options);
  log.warn(
    'no ANTHROPIC_API_KEY — falling back to the claude CLI, which spawns a subprocess per call and makes chat turns take tens of seconds',
  );
  return claudeCli(options.cli ?? {});
}
