/**
 * Live demo of the shopping chatbot.
 *
 *   node --import tsx scripts/demo-chat.ts "<message>" [prefs-topic ...]
 *
 *   node --import tsx scripts/demo-chat.ts \
 *     "find me a mechanical keyboard under $80" gaming audio
 *
 * The message is the user's chat input — the intake parser pulls the item and
 * budget out of it. Remaining args seed the fake preference vector (in the app
 * this comes from the user's stored embedding). No Mongo needed: `vectors` is
 * left unwired, so every pick comes from the live Amazon and eBay search.
 *
 * The turn is two parallel storefront fetches and one model call, so it should
 * land in seconds — the elapsed time is printed to keep that honest.
 */

import { chat } from '../src/agent/shop-chat.js';
import { localEmbeddingProvider } from '../src/embedding/local.js';
import { agentLlm } from '../src/agent/llm-api.js';
import { primedFetch } from '../src/ingestion/adapters/primed-fetch.js';

const args = process.argv.slice(2);
const message = args[0] ?? 'find me a mechanical keyboard under $80';
const prefsTopics = args.slice(1);

const embedder = localEmbeddingProvider();
// Stand-in for the user's stored preference embedding.
const preferences = await embedder.embedText(prefsTopics.join(' ') || 'tech gadgets audio gear');

// One cheap, fast model does the whole turn: intake when the regex path
// doesn't catch it, then the combined judge-and-compose call. The API when a
// key is set, the `claude` CLI when not — the CLI spawns a subprocess per
// call, which is most of the wall clock printed below.
const llm = agentLlm({ timeoutMs: 20_000, cli: { model: 'haiku', effort: 'low', timeoutMs: 60_000 } });

const money = (minor: number | null, currency: string | null) =>
  minor === null ? '?' : `${currency ?? ''}${(minor / 100).toFixed(2)}`;

console.log(`\nyou: ${message}\n`);

const started = Date.now();
const reply = await chat(
  message,
  { preferences },
  {
    llm,
    embedder,
    storefront: { fetchImpl: primedFetch, timeoutMs: 6_000 },
  },
);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`window [${reply.kind}] (${elapsed}s): ${reply.message}\n`);
if (reply.browse !== null) {
  console.log(`  → ${reply.browse.label}: "${reply.browse.topic}" in ${reply.browse.mode} mode\n`);
}
for (const pick of reply.picks) {
  console.log(
    `  ${pick.score.toFixed(3)}  ${money(pick.price, pick.currency)}  [${pick.sourceDomain ?? pick.origin}]  ${pick.title}`,
  );
  console.log(`      ${pick.url}`);
  console.log(`      image:  ${pick.imageUrl ?? '-'}`);
  if (pick.reviewNote !== null) console.log(`      review: ${pick.reviewNote}`);
  for (const s of pick.sources) console.log(`      source: ${s.title} <${s.url}>`);
}
console.log('');
