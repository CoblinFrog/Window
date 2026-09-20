/** Serves the mock merchant checkout so it can be looked at in a browser. */
import { startMockMerchant } from '../checkout/mock-merchant.js';
const m = await startMockMerchant(4545);
console.log(`mock merchant on ${m.origin}/checkout`);
