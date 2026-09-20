import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const log = logger.child('checkout.vault');

/**
 * The shipping-details vault.
 *
 * A browser checkout agent has to type a real name, a real street address and a
 * real phone number into a merchant's form. The question this file answers is
 * how it does that without the values ever being *known* to the part of the
 * system that decides what to type.
 *
 * The rule is simple and absolute: **the agent handles references, never
 * values.** It reasons about `{{ref:ship.line1}}`, the driver substitutes the
 * plaintext at the moment of the keystroke, and the value is gone again before
 * control returns. Nothing in between — not a tool call, not a model context,
 * not a log line, not a screenshot, not the audit record — has ever seen it.
 *
 * That matters because an LLM-driven agent's context is the least defensible
 * place in the system: it is serialized to a provider, retained in transcripts,
 * echoed into traces, and reconstructable from the audit trail. Address data
 * that never enters it cannot leak from it.
 */

/** A field the agent may ask to be typed, by name only. */
export type VaultField =
  | 'ship.name'
  | 'ship.line1'
  | 'ship.line2'
  | 'ship.city'
  | 'ship.region'
  | 'ship.postal'
  | 'ship.country'
  | 'ship.phone'
  | 'contact.email';

export const VAULT_FIELDS: readonly VaultField[] = [
  'ship.name',
  'ship.line1',
  'ship.line2',
  'ship.city',
  'ship.region',
  'ship.postal',
  'ship.country',
  'ship.phone',
  'contact.email',
];

/**
 * `{{ref:ship.line1}}` — what the agent sees and passes around.
 *
 * Built fresh on every use rather than shared. A module-level `/g` regex
 * carries `lastIndex` between calls, so `test()` in one function silently
 * changes where `exec()` starts in the next — and the field names here contain
 * digits (`line1`, `line2`), which is exactly the kind of detail a character
 * class gets wrong quietly.
 */
function referencePattern(): RegExp {
  return /\{\{ref:([a-z0-9._-]+)\}\}/g;
}

export function referenceFor(field: VaultField): string {
  return `{{ref:${field}}}`;
}

/** True if a string carries a reference rather than a literal value. */
export function isReference(text: string): boolean {
  return referencePattern().test(text);
}

export interface ShippingDetails {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postal: string;
  country: string;
  phone: string;
  email: string;
}

/**
 * A short-lived, per-job handle onto one user's details.
 *
 * Encrypted at rest with a key that exists only for the life of the job, so a
 * heap dump after the job ends yields ciphertext and no key. `dispose()` is
 * called in a `finally`, not on the happy path.
 */
export class VaultHandle {
  readonly id = `vault_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  private key: Buffer | null = randomBytes(32);
  private readonly entries = new Map<VaultField, { iv: Buffer; tag: Buffer; data: Buffer }>();
  /** Every field the driver actually substituted, for the audit record. */
  private readonly used = new Set<VaultField>();

  constructor(details: ShippingDetails) {
    this.put('ship.name', details.name);
    this.put('ship.line1', details.line1);
    if (details.line2) this.put('ship.line2', details.line2);
    this.put('ship.city', details.city);
    this.put('ship.region', details.region);
    this.put('ship.postal', details.postal);
    this.put('ship.country', details.country);
    this.put('ship.phone', details.phone);
    this.put('contact.email', details.email);
  }

  private put(field: VaultField, value: string): void {
    if (!this.key) throw new Error('This vault handle has been disposed.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.entries.set(field, { iv, tag: cipher.getAuthTag(), data });
  }

  /** Which fields exist. Names only — this is what the agent is allowed to know. */
  availableFields(): VaultField[] {
    return [...this.entries.keys()];
  }

  /**
   * Substitutes every reference in a string with its plaintext.
   *
   * Called by the browser driver immediately before a keystroke and nowhere
   * else. The returned string is used once and discarded; it is never returned
   * to a caller that could log it.
   */
  resolve(text: string): string {
    if (!this.key) throw new Error('This vault handle has been disposed.');

    return text.replace(referencePattern(), (whole, field: string) => {
      const entry = this.entries.get(field as VaultField);
      if (!entry) {
        // An unknown reference is left intact rather than blanked, so a typo
        // shows up as a visibly wrong form rather than a silently empty one.
        log.warn('agent referenced an unknown vault field', { field });
        return whole;
      }
      this.used.add(field as VaultField);

      const decipher = createDecipheriv('aes-256-gcm', this.key as Buffer, entry.iv);
      decipher.setAuthTag(entry.tag);
      return decipher.update(entry.data).toString('utf8') + decipher.final('utf8');
    });
  }

  /**
   * What the audit record gets: which fields were typed, and a digest of each.
   *
   * Enough to answer "did the agent fill the address it was given?" in a
   * dispute, without the ninety-day retention holding the address itself.
   */
  auditTrail(): Array<{ field: VaultField; digest: string }> {
    return [...this.used].map((field) => ({
      field,
      digest: createHash('sha256').update(field).digest('hex').slice(0, 12),
    }));
  }

  /** Zeroes the key. Every later `resolve` throws rather than returning stale data. */
  dispose(): void {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.entries.clear();
  }
}

/**
 * Removes anything that looks like a vault value from text leaving the driver.
 *
 * Defence in depth: the agent should never receive a resolved value, but DOM
 * reads come back from a page the merchant controls, and a page can echo what
 * was typed into it — a confirmation screen showing the delivery address is the
 * normal case, not an attack. This scrubs those echoes before they reach the
 * model's context or the transcript.
 */
export function scrubValues(text: string, vault: VaultHandle | null): string {
  if (!vault) return text;

  let out = text;
  for (const field of vault.availableFields()) {
    const value = vault.resolve(referenceFor(field));
    if (value.length < 3 || isReference(value)) continue;
    out = out.split(value).join(`[${field}]`);
  }
  return out;
}

/**
 * Field names the driver will never type into, whatever the agent asks.
 *
 * The vault holds no card data and the rail never exposes a PAN, so an agent
 * asking to fill a card field is either confused or being steered by page
 * content. Either way the answer is no, loudly, rather than a blank string
 * that lets the run continue as if it had worked.
 */
const FORBIDDEN_FIELD = /card|cvv|cvc|security[-_ ]?code|pan|account[-_ ]?number|routing|ssn|password/i;

export function assertFillable(selector: string, attribute = ''): void {
  const haystack = `${selector} ${attribute}`;
  if (FORBIDDEN_FIELD.test(haystack)) {
    throw new VaultViolation(
      `Refusing to type into "${selector}": it looks like a payment or credential field. ` +
        'Card details are held by the payment rail and are never typed by the agent.',
    );
  }
}

export class VaultViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultViolation';
  }
}
