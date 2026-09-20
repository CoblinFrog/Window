/**
 * The browse agent's decision-maker, through the `claude` CLI in headless mode.
 *
 * `claude -p` runs one non-interactive turn under the user's Claude
 * subscription, which means no API key is involved at all — the binary is the
 * credential. `--output-format json` wraps the reply in a result envelope so
 * usage metadata rides along if it is ever wanted; `result` is the text.
 */

import { execFile } from 'node:child_process';
import { logger } from '../lib/logger.js';

const log = logger.child('agent.llm');

export interface AgentLlm {
  decide(prompt: string): Promise<string>;
}

export interface ClaudeCliOptions {
  /** Binary name or path. Default `claude`, overridable via AGENT_LLM_BIN. */
  bin?: string;
  /** e.g. `haiku` for cheap browse decisions. Unset uses the CLI's default. */
  model?: string;
  /**
   * Headless tool allowlist, e.g. ['WebSearch', 'WebFetch']. Unset means the
   * default permission mode — in `-p` that is no tools at all.
   */
  allowedTools?: string[];
  /** Cap on agentic turns (`--max-turns`) — bounds how much a tool-using call may do. */
  maxTurns?: number;
  /** Reasoning effort (`--effort`). `low` for cheap, fast decisions. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
}

export function claudeCli(options: ClaudeCliOptions = {}): AgentLlm {
  const bin = options.bin ?? process.env.AGENT_LLM_BIN ?? 'claude';
  const model = options.model ?? process.env.AGENT_LLM_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    async decide(prompt: string): Promise<string> {
      const args = ['-p', prompt, '--output-format', 'json'];
      if (model) args.push('--model', model);
      if (options.allowedTools && options.allowedTools.length > 0) {
        args.push('--allowedTools', ...options.allowedTools);
      }
      if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
      if (options.effort) args.push('--effort', options.effort);

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, out, err) => {
          if (error) {
            reject(new Error(`${bin} -p failed: ${err || error.message}`));
            return;
          }
          resolve(out);
        });
      });

      try {
        const envelope = JSON.parse(stdout) as { result?: string };
        if (typeof envelope.result === 'string') return envelope.result;
      } catch {
        // Older CLI versions print the reply bare; the text is the answer.
      }
      return stdout;
    },
  };
}

/**
 * Pulls the first JSON object out of a reply. The model is asked for JSON only
 * but may wrap it in prose or a code fence; this takes the outermost balanced
 * object rather than trusting the whole string.
 */
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          log.debug('extracted json did not parse', { excerpt: text.slice(start, start + 120) });
          return null;
        }
      }
    }
  }
  return null;
}
