import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Warnings here go straight to stderr rather than through the logger.
 *
 * The logger is configured from `env`, and `env` is configured from this file —
 * importing it here closes a cycle that fails at module-initialisation time.
 * That is the right dependency direction anyway: secrets are resolved during
 * module load, before there is a configured logger to resolve them for.
 */
function warn(message: string, note: string): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'secrets', message, note })}\n`);
}

/**
 * Secrets, and what happens when they are missing.
 *
 * A development fallback that silently becomes a production default is how
 * most real breaches of systems like this one actually begin — nobody decides
 * to ship `dev-internal-token`, they just never notice it was still there. So
 * every secret here has exactly one behaviour outside development: refuse to
 * boot. A server that will not start is a page at 3am; a server that started
 * with a guessable signing key is an incident nobody sees for months.
 */

export class MisconfiguredSecret extends Error {
  constructor(name: string, detail: string) {
    super(`${name} ${detail}`);
    this.name = 'MisconfiguredSecret';
  }
}

const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

/**
 * Reads a secret, or refuses.
 *
 * In production the variable must be present and long enough to be worth
 * signing with. Outside it, an ephemeral per-process value is generated and
 * announced — ephemeral rather than a fixed literal, because a fixed
 * development default is a credential that leaks into commits, screenshots and
 * `docker inspect` output, and because a signing key that dies with the process
 * cannot outlive the machine it was useful on.
 */
export function requireSecret(name: string, minLength = 32): string {
  const value = process.env[name];

  if (value && value.length >= minLength) return value;

  if (isProduction) {
    throw new MisconfiguredSecret(
      name,
      value
        ? `must be at least ${minLength} characters; got ${value.length}.`
        : 'is required in production and was not set.',
    );
  }

  if (value) {
    throw new MisconfiguredSecret(
      name,
      `must be at least ${minLength} characters; got ${value.length}. ` +
        'Unset it to use a generated development value, or set a real one.',
    );
  }

  const generated = randomBytes(32).toString('base64url');
  warn(
    `${name} is unset; generated an ephemeral development value`,
    'Tokens signed with it die with this process. Production refuses to boot without a real one.',
  );
  return generated;
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `a !== b` on strings returns at the first differing byte, which is a byte
 * oracle: an attacker who can time a few thousand requests recovers the value
 * one character at a time. The length is compared separately and deliberately —
 * length is not secret, and `timingSafeEqual` throws on a mismatch.
 */
export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const secretsAreProduction = isProduction;
