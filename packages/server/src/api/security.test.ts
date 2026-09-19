import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';

process.env.AUTH_SECRET ??= 'a'.repeat(48);
process.env.INTERNAL_TOKEN ??= 'b'.repeat(48);

const { SESSION_CONFIG } = await import('@window/shared');
const { mintToken, verifyToken, hashDeviceSecret, mintDeviceSecret, isAnonymousUser } = await import(
  './auth.js'
);
const { secretsMatch } = await import('../config/secrets.js');
const {
  hasPollutedKey,
  isSafeKey,
  objectIdSchema,
  merchantDomainSchema,
  opaqueSecretSchema,
  safeRecord,
  sanitizeRecord,
} = await import('./validation.js');
const { issueEmailChallenge, normalizeEmail, verifyEmailChallenge, LoggingMailer } = await import(
  './claims.js'
);
const { MemoryCache } = await import('../cache/index.js');
const { redactToolCall } = await import('../checkout/orchestrator.js');
const { capFor, assertSpendRules, SimulatedPaymentRail, DEFAULT_SPEND_RULES } = await import(
  '../checkout/payments.js'
);

/**
 * These tests are the argument that each control actually holds.
 *
 * Every case below is written as the attack it refuses, not as the behaviour it
 * permits — a test that only proves the happy path passes just as well against
 * a system with the check deleted.
 */

const principal = {
  userId: new ObjectId('507f1f77bcf86cd799439011'),
  deviceUserId: 'dev_0123456789abcdef',
  isAnonymous: true,
  epoch: 3,
};

describe('session tokens', () => {
  it('round-trips a token it minted', () => {
    const claims = verifyToken(mintToken(principal));
    assert.equal(claims.userId.toHexString(), principal.userId.toHexString());
    assert.equal(claims.epoch, 3);
  });

  it('refuses a token whose payload was edited', () => {
    const [version, payload, signature] = mintToken(principal).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: new ObjectId().toHexString(),
        dev: 'x',
        epc: 1,
        iat: Date.now(),
        exp: Date.now() + 1000,
        aud: 'window.api',
      }),
    ).toString('base64url');

    assert.throws(() => verifyToken(`${version}.${forged}.${signature}`), /signature/i);
    assert.ok((payload ?? '').length > 0);
  });

  it('refuses an expired token', () => {
    const issued = Date.now() - SESSION_CONFIG.tokenTtlMs - 1000;
    assert.throws(() => verifyToken(mintToken(principal, issued)), /expired/i);
  });

  it('refuses a token minted beyond the tolerated clock skew', () => {
    const future = Date.now() + SESSION_CONFIG.clockSkewMs + 60_000;
    assert.throws(() => verifyToken(mintToken(principal, future)), /not yet valid/i);
  });

  it('refuses the old unversioned format outright', () => {
    // v1 carried no expiry and no epoch, so it can be neither aged out nor
    // revoked. There is no safe way to keep honouring one.
    const payload = Buffer.from(JSON.stringify({ sub: 'x', dev: 'y', anon: false })).toString(
      'base64url',
    );
    assert.throws(() => verifyToken(`${payload}.whatever`), /no longer accepted|Malformed/i);
  });

  it('carries the epoch so a revocation can invalidate it', () => {
    // The middleware compares this against the user document; bumping the
    // document's epoch is what makes "sign out everywhere" true.
    assert.equal(verifyToken(mintToken({ ...principal, epoch: 9 })).epoch, 9);
  });
});

describe('device credentials', () => {
  it('mints 256 bits from the CSPRNG, not a sequence', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => mintDeviceSecret()));
    assert.equal(secrets.size, 500);
    // 32 bytes base64url, unpadded.
    assert.equal(mintDeviceSecret().length, 43);
  });

  it('stores only a hash, so a dump of the collection authenticates nobody', () => {
    const secret = mintDeviceSecret();
    const stored = hashDeviceSecret(secret);
    assert.notEqual(stored, secret);
    assert.equal(stored, hashDeviceSecret(secret));
    assert.match(stored, /^[a-f0-9]{64}$/);
  });

  it('rejects a handle, a wildcard or an operator in the secret position', () => {
    for (const candidate of ['dev_0123456789abcdef', '*', '', '{"$ne":null}', 'a'.repeat(200)]) {
      assert.equal(opaqueSecretSchema.safeParse(candidate).success, false, candidate);
    }
    assert.equal(opaqueSecretSchema.safeParse(mintDeviceSecret()).success, true);
  });
});

describe('privilege is read from the document, not the token', () => {
  const base = { auth: null } as never;

  it('treats an unclaimed profile as anonymous', () => {
    assert.equal(isAnonymousUser(base), true);
  });

  it('treats a claimed-but-unverified profile as anonymous', () => {
    // The old email path wrote an `auth` block without ever proving ownership.
    // Even if such a document exists, it must not clear the order gate.
    const unverified = {
      auth: { email: 'a@b.test', providers: ['email'], claimedAt: new Date(), emailVerifiedAt: null },
    } as never;
    assert.equal(isAnonymousUser(unverified), true);
  });

  it('treats a verified profile as authenticated', () => {
    const verified = {
      auth: {
        email: 'a@b.test',
        providers: ['email'],
        claimedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    } as never;
    assert.equal(isAnonymousUser(verified), false);
  });
});

describe('email ownership challenge', () => {
  const userId = '507f1f77bcf86cd799439011';

  async function issue(email = 'Buyer@Example.TEST') {
    const cache = new MemoryCache();
    const outbox: Array<{ to: string; code: string }> = [];
    const mailer = {
      kind: 'logging' as const,
      async send(to: string, code: string) {
        outbox.push({ to, code });
      },
    };
    await issueEmailChallenge(cache, mailer, userId, email);
    return { cache, code: outbox[0]!.code, sentTo: outbox[0]!.to };
  }

  it('accepts only the code that was actually sent', async () => {
    const { cache, code } = await issue();
    const wrong = code === '000000' ? '111111' : '000000';

    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', wrong)).ok, false);
    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', code)).ok, true);
  });

  it('burns the code on success, so it cannot be replayed', async () => {
    const { cache, code } = await issue();
    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', code)).ok, true);

    const replay = await verifyEmailChallenge(cache, userId, 'buyer@example.test', code);
    assert.equal(replay.ok, false);
    assert.equal(replay.ok === false && replay.reason, 'no_challenge');
  });

  it('binds the code to the address it was sent to', async () => {
    // Otherwise a code delivered to an inbox the caller controls could be
    // redeemed against somebody else's address.
    const { cache, code } = await issue();
    const result = await verifyEmailChallenge(cache, userId, 'victim@example.test', code);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'wrong_address');
  });

  it('burns the challenge after too many wrong codes', async () => {
    // A six-digit code is only sound because guessing is bounded. Unbounded,
    // a million tries is minutes of work.
    const { cache, code } = await issue();
    const wrong = code === '000000' ? '111111' : '000000';

    let last = await verifyEmailChallenge(cache, userId, 'buyer@example.test', wrong);
    for (let i = 1; i < SESSION_CONFIG.emailCodeMaxAttempts; i += 1) {
      last = await verifyEmailChallenge(cache, userId, 'buyer@example.test', wrong);
    }
    assert.equal(last.ok === false && last.reason, 'too_many_attempts');

    // The correct code no longer works either: the challenge is gone.
    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', code)).ok, false);
  });

  it('refuses a claim with no challenge outstanding', async () => {
    const cache = new MemoryCache();
    const result = await verifyEmailChallenge(cache, userId, 'buyer@example.test', '123456');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no_challenge');
  });

  it('normalizes case so one human is one account', () => {
    assert.equal(normalizeEmail('Buyer@Example.TEST'), 'buyer@example.test');
    assert.throws(() => normalizeEmail('not-an-address'));
  });

  it('never writes a path separator into the development outbox name', async () => {
    const mailer = new LoggingMailer('/tmp/window-test-outbox-should-not-escape');
    assert.equal(mailer.kind, 'logging');
    const { devOutboxName } = await import('./claims.js');
    assert.match(devOutboxName('../../etc/passwd@x.test'), /^[a-f0-9]{32}$/);
  });
});

describe('secret comparison', () => {
  it('matches an identical secret and rejects everything else', () => {
    assert.equal(secretsMatch('s3cret-value-that-is-long', 's3cret-value-that-is-long'), true);
    assert.equal(secretsMatch('s3cret-value-that-is-lone', 's3cret-value-that-is-long'), false);
    assert.equal(secretsMatch(undefined, 'anything'), false);
    assert.equal(secretsMatch('', 'anything'), false);
    // A prefix must not pass: the old `!==` leaked where the mismatch was.
    assert.equal(secretsMatch('s3cret', 's3cret-value-that-is-long'), false);
  });
});

describe('injection boundaries', () => {
  it('rejects Mongo operators and path traversal in map keys', () => {
    for (const key of ['$ne', '$where', 'a.b', '__proto__', 'constructor', 'prototype']) {
      assert.equal(isSafeKey(key), false, key);
    }
    for (const key of ['Size', 'color-way', 'US Men 10']) {
      assert.equal(isSafeKey(key), true, key);
    }
  });

  it('refuses a variant map carrying an operator key', () => {
    const schema = safeRecord();
    assert.equal(schema.safeParse({ Size: 'M' }).success, true);
    assert.equal(schema.safeParse({ $ne: 'M' }).success, false);
    assert.equal(schema.safeParse({ 'a.b': 'M' }).success, false);
  });

  it('bounds a variant map so it cannot be used as bulk storage', () => {
    const schema = safeRecord({ maxKeys: 2 });
    assert.equal(schema.safeParse({ a: '1', b: '2' }).success, true);
    assert.equal(schema.safeParse({ a: '1', b: '2', c: '3' }).success, false);
    assert.equal(safeRecord().safeParse({ a: 'x'.repeat(1000) }).success, false);
  });

  it('strips a poisoned key rather than assigning through the prototype', () => {
    const cleaned = sanitizeRecord(JSON.parse('{"Size":"M","__proto__":"owned"}'));
    assert.deepEqual(Object.keys(cleaned), ['Size']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('detects a prototype-poisoning key at any depth', () => {
    assert.equal(hasPollutedKey(JSON.parse('{"a":1}')), false);
    assert.equal(hasPollutedKey(JSON.parse('{"__proto__":{"admin":true}}')), true);
    assert.equal(hasPollutedKey(JSON.parse('{"a":{"b":{"constructor":1}}}')), true);
    assert.equal(hasPollutedKey(JSON.parse('[{"prototype":1}]')), true);
  });

  it('rejects a non-hex id before it reaches a query', () => {
    // `new ObjectId(garbage)` throws a BSONError the problem handler can only
    // render as a 500 — a 400 reported as a server fault, with a stack per probe.
    for (const candidate of ['', 'abc', '../../etc/passwd', '{"$gt":""}', 'z'.repeat(24)]) {
      assert.equal(objectIdSchema.safeParse(candidate).success, false, candidate);
    }
    assert.equal(objectIdSchema.safeParse('507f1f77bcf86cd799439011').success, true);
  });

  it('rejects anything but a bare hostname as a merchant domain', () => {
    for (const candidate of [
      'https://evil.test',
      'shop.test/../admin',
      'user:pass@shop.test',
      'shop.test?x=1',
      'localhost',
    ]) {
      assert.equal(merchantDomainSchema.safeParse(candidate).success, false, candidate);
    }
    assert.equal(merchantDomainSchema.safeParse('shop.example.com').success, true);
  });
});

describe('checkout audit redaction', () => {
  it('keeps what the agent did and discards what it typed', () => {
    const redacted = redactToolCall({
      tool: 'type',
      args: { selector: '#shipping-address', value: '221B Baker Street' },
      at: new Date('2026-01-01T00:00:00Z'),
      result: 'ok',
    });

    assert.equal((redacted.args as Record<string, unknown>).selector, '#shipping-address');
    // The field is recorded, the value is not. A ninety-day audit store of
    // addresses next to user ids exists only to be breached.
    assert.equal((redacted.args as Record<string, unknown>).value, '<redacted:17>');
    assert.ok(!JSON.stringify(redacted).includes('Baker Street'));
  });

  it('truncates merchant-controlled result text', () => {
    const redacted = redactToolCall({
      tool: 'read_dom',
      args: {},
      at: new Date(),
      result: 'x'.repeat(5000),
    });
    assert.equal((redacted.result as string).length, 256);
  });
});

describe('payment rail invariants', () => {
  const request = {
    userId: 'u',
    jobId: 'job_1',
    merchantDomain: 'shop.test',
    merchantCategory: 'new',
    authorizedAmount: 10_000,
    currency: 'USD',
    quoteHash: 'h'.repeat(64),
    passkeyAssertion: 'tap_1',
    ordersToday: 0,
    rules: DEFAULT_SPEND_RULES,
  };

  it('refuses to mint an intent without an authorization tap', () => {
    assert.throws(
      () => assertSpendRules({ ...request, passkeyAssertion: '' }),
      /passkey/i,
    );
  });

  it('caps a capture at the authorized amount plus tolerance', async () => {
    const rail = new SimulatedPaymentRail();
    const intent = await rail.createIntent(request);

    const over = await rail.capture(intent.intentId, capFor(request.authorizedAmount) + 1);
    assert.equal(over.captured, false);
    assert.equal(over.reason, 'above_cap');
  });

  it('allows exactly one capture per authorization', async () => {
    const rail = new SimulatedPaymentRail();
    const intent = await rail.createIntent(request);

    assert.equal((await rail.capture(intent.intentId, 10_000)).captured, true);
    const second = await rail.capture(intent.intentId, 10_000);
    assert.equal(second.captured, false);
    assert.equal(second.reason, 'already_captured');
  });

  it('refuses a capture against a revoked intent', async () => {
    const rail = new SimulatedPaymentRail();
    const intent = await rail.createIntent(request);
    await rail.revoke(intent.intentId);

    assert.equal((await rail.capture(intent.intentId, 10_000)).captured, false);
  });

  it('binds the token reference to the exact quote that was authorized', async () => {
    const rail = new SimulatedPaymentRail();
    const a = await rail.createIntent(request);
    const b = await rail.createIntent({ ...request, quoteHash: 'g'.repeat(64) });

    // A token minted for one quote can never be replayed against another.
    assert.notEqual(a.tokenRef, b.tokenRef);
  });
});
