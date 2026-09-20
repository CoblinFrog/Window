import { createServer, type Server } from 'node:http';

/**
 * A stand-in merchant, for exercising the browser agent end to end.
 *
 * It exists because the alternative — pointing the agent at a real retailer —
 * is wrong on three counts: their robots.txt disallows the checkout paths this
 * would drive, their terms prohibit automated purchasing, and filling a live
 * checkout with invented details puts junk in somebody else's order system.
 *
 * It is also simply better verification. The agent's behaviour here is
 * deterministic and asserted, the page is checked into the repository next to
 * the test, and the whole thing runs in CI without a network. A real site
 * changes its DOM on a Tuesday and the suite goes red for reasons that have
 * nothing to do with the code.
 *
 * The form is deliberately awkward in the ways real checkouts are: the fields
 * are not in a helpful order, the labels do not match the `name` attributes,
 * there is a card section the agent must refuse to touch, and the final button
 * is the only thing standing between the run and a placed order.
 */
export interface MockMerchant {
  readonly origin: string;
  /** Set once the place-order button is actually pressed. */
  readonly orderPlaced: () => boolean;
  close(): Promise<void>;
}

export async function startMockMerchant(port = 0): Promise<MockMerchant> {
  let placed = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/robots.txt') {
      // Explicitly permits checkout, which is what makes it a legitimate target
      // and is exactly the thing a real retailer's robots.txt does not say.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }

    if (url.pathname === '/place-order' && req.method === 'POST') {
      placed = true;
      res.writeHead(303, { location: '/confirmation' });
      res.end();
      return;
    }

    if (url.pathname === '/whoami') {
      // Issues a session cookie on first contact and echoes it thereafter, so a
      // test can observe whether two jobs share a storage partition.
      const existing = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
      const sid = existing ?? Math.random().toString(36).slice(2, 10);
      res.writeHead(200, {
        'content-type': 'text/html',
        ...(existing ? {} : { 'set-cookie': `sid=${sid}; Path=/` }),
      });
      res.end(page(`<div class="card">session <strong id="sid">${sid}</strong></div>`));
      return;
    }

    if (url.pathname === '/confirmation') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(CONFIRMATION));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(CHECKOUT));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    origin: `http://127.0.0.1:${actualPort}`,
    orderPlaced: () => placed,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Northwind Supply</title>
<style>
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f6f6f7;color:#111}
 .wrap{max-width:720px;margin:0 auto;padding:32px 24px}
 h1{font-size:20px;margin:0 0 4px} .muted{color:#666;font-size:13px}
 .card{background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:20px;margin:16px 0}
 label{display:block;font-size:12px;color:#555;margin:12px 0 4px}
 input,select{width:100%;padding:9px 10px;border:1px solid #cfcfd4;border-radius:6px;font-size:14px;box-sizing:border-box}
 .row{display:flex;gap:12px} .row>div{flex:1}
 .totals{display:flex;justify-content:space-between;padding:4px 0}
 .totals.grand{font-weight:600;border-top:1px solid #e3e3e6;margin-top:8px;padding-top:10px}
 button{width:100%;padding:13px;border:0;border-radius:8px;background:#0a7d34;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 .danger{border-color:#e0b4b4;background:#fdf7f7}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

const CHECKOUT = `
<h1>Northwind Supply</h1>
<div class="muted">Checkout — step 2 of 2</div>

<form method="POST" action="/place-order">
  <div class="card">
    <strong>Delivery</strong>
    <label for="f-recipient">Full name</label>
    <input id="f-recipient" name="recipient_full" autocomplete="name">

    <label for="f-street">Street address</label>
    <input id="f-street" name="addr_primary" autocomplete="address-line1">

    <label for="f-street2">Apartment, suite (optional)</label>
    <input id="f-street2" name="addr_secondary" autocomplete="address-line2">

    <div class="row">
      <div>
        <label for="f-town">Town / City</label>
        <input id="f-town" name="locality" autocomplete="address-level2">
      </div>
      <div>
        <label for="f-state">State</label>
        <input id="f-state" name="admin_area" autocomplete="address-level1">
      </div>
      <div>
        <label for="f-zip">ZIP</label>
        <input id="f-zip" name="postcode" autocomplete="postal-code">
      </div>
    </div>

    <label for="f-phone">Phone</label>
    <input id="f-phone" name="contact_tel" autocomplete="tel">

    <label for="f-email">Email for receipt</label>
    <input id="f-email" name="contact_mail" autocomplete="email">

    <label for="f-ship">Shipping method</label>
    <select id="f-ship" name="ship_speed">
      <option value="standard">Standard — 5-7 days (free)</option>
      <option value="express">Express — 2 days ($12.00)</option>
    </select>
  </div>

  <div class="card danger">
    <strong>Payment</strong>
    <div class="muted">The agent must never touch these. Card data is held by the rail.</div>
    <label for="f-card">Card number</label>
    <input id="f-card" name="card_number" autocomplete="cc-number">
    <div class="row">
      <div><label for="f-exp">Expiry</label><input id="f-exp" name="cc_exp"></div>
      <div><label for="f-cvv">CVV</label><input id="f-cvv" name="card_cvv" autocomplete="cc-csc"></div>
    </div>
  </div>

  <div class="card">
    <div class="totals"><span>Subtotal</span><span id="t-subtotal">$64.00</span></div>
    <div class="totals"><span>Shipping</span><span id="t-shipping">$0.00</span></div>
    <div class="totals"><span>Tax</span><span id="t-tax">$5.44</span></div>
    <div class="totals"><span>Discount</span><span id="t-discount">-$6.40</span></div>
    <div class="totals grand"><span>Total</span><span id="t-total">$63.04</span></div>
  </div>

  <button type="submit" id="place-order">Place your order</button>
</form>`;

const CONFIRMATION = `
<h1>Order confirmed</h1>
<div class="card">
  <div>Thank you. Your order number is <strong id="order-number">NW-4417-2290</strong>.</div>
</div>`;
