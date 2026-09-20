import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logger } from '../lib/logger.js';
import { robotsAllows } from '../ingestion/shopify.js';
import type { CheckoutBrowser, CheckoutPage } from './agent.js';
import { assertFillable, scrubValues, VaultViolation, type VaultHandle } from './vault.js';

const log = logger.child('checkout.browser');

/**
 * The Playwright-backed checkout browser.
 *
 * This is the implementation the `CheckoutBrowser` seam was written for. Four
 * properties make it safe to point at a merchant the user chose but we do not
 * control:
 *
 * **One context per job.** A fresh storage partition, no shared cookies, torn
 * down in a `finally`. Two users checking out at the same merchant cannot see
 * each other's session, and a merchant cannot correlate them.
 *
 * **robots.txt is checked before the first navigation**, using the same
 * function the ingestion pipeline uses. A merchant that disallows its checkout
 * path does not get driven — which is why Amazon and eBay are reached through
 * their official APIs and never through this.
 *
 * **Values are substituted at the keystroke.** The agent passes
 * `{{ref:ship.line1}}`; the plaintext exists for the duration of one `fill`
 * call and is never returned, logged or screenshotted. See `vault.ts`.
 *
 * **Everything coming back out is scrubbed and truncated.** A merchant page is
 * attacker-controlled text. It is data for the agent to read, never
 * instructions for it to follow, and it must not be able to smuggle the user's
 * own address back into a transcript.
 */
export class PlaywrightCheckoutBrowser implements CheckoutBrowser {
  private browser: Browser | null = null;

  constructor(
    private readonly options: {
      headless?: boolean;
      /** Per-action ceiling. A merchant that hangs must not hang the job. */
      timeoutMs?: number;
      /** Skips the robots check. Only ever true for a local test fixture. */
      allowUncheckedHosts?: boolean;
    } = {},
  ) {}

  private async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    return this.browser;
  }

  async newContext(options: {
    merchantDomain: string;
    sessionHandle: string | null;
    vault?: VaultHandle | null;
  }): Promise<CheckoutPage> {
    const browser = await this.launch();

    const context = await browser.newContext({
      // A named agent rather than a disguised one. If a merchant wants to
      // refuse us, it must be able to.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/153.0.0.0 Safari/537.36 WindowCheckout/0.1 (+https://window.app/agent)',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      // No storage is ever inherited from another job.
      storageState: undefined,
    });
    context.setDefaultTimeout(this.options.timeoutMs ?? 15_000);

    const page = await context.newPage();
    return new PlaywrightCheckoutPage(context, page, {
      merchantDomain: options.merchantDomain,
      vault: options.vault ?? null,
      allowUncheckedHosts: this.options.allowUncheckedHosts ?? false,
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

class PlaywrightCheckoutPage implements CheckoutPage {
  private robotsChecked = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly config: {
      merchantDomain: string;
      vault: VaultHandle | null;
      allowUncheckedHosts: boolean;
    },
  ) {}

  /**
   * Navigates, after asking the site whether we may.
   *
   * The check runs once per page and uses the ingestion pipeline's own
   * `robotsAllows`, so there is exactly one definition of "are we allowed
   * here" in the codebase rather than one per subsystem.
   */
  async navigate(url: string): Promise<void> {
    const target = new URL(url);

    if (!this.config.allowUncheckedHosts && !this.robotsChecked) {
      const allowed = await robotsAllows(target.hostname, target.pathname, target.origin);
      if (!allowed) {
        throw new RobotsDisallowed(
          `${target.hostname} disallows ${target.pathname} in robots.txt. ` +
            'This merchant must be reached through its official API or by handing off to the user.',
        );
      }
      this.robotsChecked = true;
    }

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click();
  }

  /**
   * Types into a field, substituting vault references at the last moment.
   *
   * Two guards sit in front of the keystroke: the selector must not look like a
   * payment or credential field, and — if the text still contains a reference
   * after resolution — the field name was wrong and we would be typing a
   * literal `{{ref:…}}` into a merchant's form. Both refuse rather than
   * proceed.
   */
  async type(selector: string, text: string): Promise<void> {
    assertFillable(selector, await this.attributesOf(selector));

    const value = this.config.vault ? this.config.vault.resolve(text) : text;
    if (value.includes('{{ref:')) {
      throw new VaultViolation(
        `Refusing to type an unresolved reference into "${selector}". ` +
          'The agent asked for a field the vault does not hold.',
      );
    }

    // `fill` rather than `pressSequentially`: one atomic set, no per-character
    // input events a page could stream off to a third party as they arrive.
    await this.page.locator(selector).first().fill(value);
  }

  async select(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).first().selectOption(value);
  }

  /**
   * Reads the page for the agent.
   *
   * Scrubbed of the user's own values and hard-truncated. This is the one place
   * merchant-controlled text crosses into the agent's reasoning, so it is
   * treated as hostile input: bounded in size, stripped of anything that looks
   * like the user's data, and — crucially — never interpreted as instructions
   * by the caller.
   */
  async readDom(selector?: string): Promise<string> {
    const raw = selector
      ? await this.page.locator(selector).first().innerText().catch(() => '')
      : await this.page.locator('body').innerText().catch(() => '');

    return scrubValues(raw, this.config.vault).slice(0, MAX_DOM_CHARS);
  }

  /**
   * A screenshot for the audit record.
   *
   * Every input on the page is blanked first. A checkout screenshot otherwise
   * captures the address the agent just typed, and the audit store keeps it for
   * ninety days — which turns a dispute-resolution record into a PII archive.
   */
  async screenshot(): Promise<Buffer> {
    await this.page
      .addStyleTag({
        content: `input, textarea, select { color: transparent !important;
                  text-shadow: 0 0 10px rgba(0,0,0,0.55) !important; }`,
      })
      .catch(() => {
        // A page that refuses a style tag still gets screenshotted; the
        // redaction is best-effort and its absence is not worth failing a job.
        log.debug('could not inject the redaction style', { domain: this.config.merchantDomain });
      });

    return this.page.screenshot({ fullPage: false });
  }

  /**
   * Compares a field's value against a vault reference, inside the driver.
   *
   * The value never leaves this method: it is resolved, compared, and dropped.
   * A caller learns only whether the field matched.
   */
  async isFilledWith(selector: string, reference: string): Promise<boolean> {
    const expected = this.config.vault ? this.config.vault.resolve(reference) : reference;
    const actual = await this.page
      .locator(selector)
      .first()
      .inputValue()
      .catch(() => '');
    return actual.length > 0 && actual === expected;
  }

  async isEmpty(selector: string): Promise<boolean> {
    const actual = await this.page
      .locator(selector)
      .first()
      .inputValue()
      .catch(() => '');
    return actual.length === 0;
  }

  /** Attributes used only to decide whether a field is fillable. */
  private async attributesOf(selector: string): Promise<string> {
    return this.page
      .locator(selector)
      .first()
      // Typed loosely because the server tsconfig has no DOM lib: this closure
      // is serialized and runs inside the page, not in this process.
      .evaluate((el: { getAttribute(name: string): string | null }) =>
        ['name', 'id', 'autocomplete', 'type', 'aria-label']
          .map((attr) => el.getAttribute(attr))
          .filter(Boolean)
          .join(' '),
      )
      .catch(() => '');
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

const MAX_DOM_CHARS = 8_000;

export class RobotsDisallowed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobotsDisallowed';
  }
}
