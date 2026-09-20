/**
 * The fetch used by the web adapters.
 *
 * A plain `fetch` carries Node's TLS fingerprint, which Akamai (eBay) and
 * PerimeterX refuse with a 403 regardless of headers. The escalation is a
 * vendored `curl_cffi` helper — `scripts/fetch_page.py` — which impersonates a
 * real browser's fingerprint, primes the session against the site's homepage
 * so the bot manager issues its cookies, and persists the jar per domain.
 *
 * The wrapper is a `FetchLike`, so it drops into `fetchPage` unchanged: the
 * first attempt is a plain fetch (cheap, and plenty of sources answer it), and
 * a refused status or a challenge body escalates to the helper. Domains that
 * have escalated once skip the plain attempt for the rest of the process —
 * paying a guaranteed 403 on every request just to learn nothing is worse
 * than remembering.
 */

import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './tier2-structured.js';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 503 belongs here: Amazon's bot manager answers automated reads with a 503
// "Sorry! Something went wrong!" page rather than a 403, so leaving it out meant
// the plain attempt's refusal was treated as a successful fetch and never
// escalated to the impersonating helper.
const BLOCKED_STATUSES = new Set([401, 403, 405, 429, 503]);
const CHALLENGE_MARKERS = [
  'Just a moment',
  'cf_chl_opt',
  'cf-mitigated',
  'Pardon our interruption',
  'Robot Check',
  'validateCaptcha',
  'Enter the characters',
  'Enable JavaScript and cookies to continue',
  // Akamai Bot Manager serves its interstitial with HTTP 200 and a meta-refresh
  // carrying a `bm-verify` token. Without this marker the challenge page is
  // handed to the adapters, which parse it into zero listings and report the
  // source as simply empty.
  'bm-verify',
  // Amazon's automated-access notice, which accompanies the 503 above.
  'To discuss automated access to Amazon data',
];

const escalatedDomains = new Set<string>();

function scriptPath(): string {
  return fileURLToPath(new URL('../../../scripts/fetch_page.py', import.meta.url));
}

function jarDir(): string {
  return process.env.WINDOW_COOKIE_JAR_DIR
    ?? fileURLToPath(new URL('../../../.data/cookies', import.meta.url));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function isChallengeBody(body: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => body.includes(marker));
}

interface HelperResult {
  url: string;
  status: number;
  final_url: string;
  blocked: boolean;
  error?: string;
  body: string;
}

function fetchViaPython(url: string, signal?: AbortSignal | null): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [scriptPath(), '--jar-dir', jarDir(), url],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`fetch_page.py failed: ${stderr || error.message}`));
          return;
        }
        try {
          const results = JSON.parse(stdout) as HelperResult[];
          const first = results[0];
          if (!first) {
            reject(new Error('fetch_page.py returned no result'));
            return;
          }
          resolve(first);
        } catch {
          reject(new Error(`fetch_page.py returned unparseable output: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

/**
 * `fetch` first, browser-impersonation helper on refusal.
 *
 * The returned object is a real `Response` over the body text so callers —
 * `fetchPage`, and through it every adapter — keep their existing contract.
 * `response.url` carries the final URL the helper landed on, which `fetchPage`
 * uses for canonical resolution.
 */
export const primedFetch: FetchLike = async (input, init) => {
  const url = String(input);
  const host = hostnameOf(url);

  if (!escalatedDomains.has(host)) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: init?.signal ?? null,
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } catch {
      escalatedDomains.add(host);
      return primedFetch(input, init);
    }

    const body = await response.text();
    if (!BLOCKED_STATUSES.has(response.status) && !isChallengeBody(body)) {
      return new Response(body, { status: response.status, headers: response.headers });
    }
    escalatedDomains.add(host);
  }

  const result = await fetchViaPython(url, init?.signal);
  if (result.error) {
    return new Response('', { status: 502 });
  }
  const headers = new Headers();
  if (result.final_url && result.final_url !== url) {
    // `Response` has no setter for url; callers that care read the header.
    headers.set('x-final-url', result.final_url);
  }
  return new Response(result.body, { status: result.status, headers });
};

/**
 * Sitemaps ship as `.xml.gz` files — binary content, not a transport encoding,
 * so the text path above would hand back mojibake. Plain fetch is usually
 * enough (sitemaps are the surface sites *want* crawled); the helper is the
 * fallback for a refused read.
 */
export async function fetchSitemapBody(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: signal ?? null,
      headers: { 'user-agent': BROWSER_UA, accept: 'application/xml,text/xml,*/*' },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  } catch {
    const result = await fetchViaPython(url, signal);
    return result.error || result.blocked ? null : result.body;
  }
}
