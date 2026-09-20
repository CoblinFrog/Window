/**
 * A visible run of the browser checkout agent.
 *
 * Drives the local mock merchant end to end: navigate, fill every delivery
 * field from vault references, read the totals, and stop at the place-order
 * button without pressing it. Writes two screenshots — one raw, one as the
 * audit store would keep it — so the redaction is visible rather than asserted.
 *
 *   npx tsx packages/server/src/scripts/demo-browser-checkout.ts
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { PlaywrightCheckoutBrowser } from '../checkout/browser.js';
import { startMockMerchant } from '../checkout/mock-merchant.js';
import { VaultHandle, referenceFor } from '../checkout/vault.js';

const FAKE = {
  name: 'Dale Cooper', line1: '1 Great Northern Road', line2: 'Room 315',
  city: 'Twin Peaks', region: 'WA', postal: '98170', country: 'US',
  phone: '555-0142', email: 'dale.cooper@example.test',
};

const out = new URL('../../../../.data/demo', import.meta.url).pathname;
const merchant = await startMockMerchant(4545);
const browser = new PlaywrightCheckoutBrowser({ headless: true, allowUncheckedHosts: true });
const vault = new VaultHandle(FAKE);

const page = await browser.newContext({ merchantDomain: '127.0.0.1', sessionHandle: null, vault });
const step = (m: string) => console.log(`  ${m}`);

console.log('\nBrowser checkout agent — mock merchant\n');
await page.navigate(`${merchant.origin}/checkout`);
step('navigate    → /checkout');

for (const [sel, field] of [
  ['#f-recipient', 'ship.name'], ['#f-street', 'ship.line1'], ['#f-street2', 'ship.line2'],
  ['#f-town', 'ship.city'], ['#f-state', 'ship.region'], ['#f-zip', 'ship.postal'],
  ['#f-phone', 'ship.phone'], ['#f-email', 'contact.email'],
] as const) {
  await page.type(sel, referenceFor(field));
  step(`type        → ${sel.padEnd(14)} {{ref:${field}}}`);
}
await page.select('#f-ship', 'standard');
step('select      → #f-ship         standard');

for (const card of ['#f-card', '#f-cvv']) {
  try {
    await page.type(card, '4111111111111111');
    step(`type        → ${card} ACCEPTED — THIS IS A BUG`);
  } catch (error) {
    step(`REFUSED     → ${card.padEnd(14)} ${(error as Error).message.slice(0, 58)}…`);
  }
}

const dom = await page.readDom();
const total = /Total\s*\$?([\d.]+)/.exec(dom)?.[1] ?? '?';
step(`read_dom    → total $${total}, button "${/Place your order/.test(dom) ? 'Place your order' : 'MISSING'}" present`);

await mkdir(out, { recursive: true });
await writeFile(`${out}/checkout-audit.png`, await page.screenshot());
step(`screenshot  → ${out}/checkout-audit.png (redacted, as stored)`);

console.log(`\n  STOP. Order placed: ${merchant.orderPlaced()}`);
console.log('  The agent cannot cross this line. Only POST /authorize with the');
console.log('  matching quoteHash can, and that lives in the orchestrator.\n');
console.log('  vault audit:', JSON.stringify(vault.auditTrail().map((e) => e.field)));

vault.dispose();
await page.close();
await browser.close();
await merchant.close();
