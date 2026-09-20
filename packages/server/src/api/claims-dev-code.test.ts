import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

process.env.AUTH_SECRET ??= 'a'.repeat(48);
process.env.INTERNAL_TOKEN ??= 'b'.repeat(48);

const { issueEmailChallenge, verifyEmailChallenge } = await import('./claims.js');
const { MemoryCache } = await import('../cache/index.js');

const userId = 'user-dev-code';

/** Issues one challenge and reports the code the transport was handed. */
async function issue(): Promise<{ cache: InstanceType<typeof MemoryCache>; code: string }> {
  const cache = new MemoryCache();
  let sent = '';
  await issueEmailChallenge(
    cache,
    { kind: 'logging' as const, async send(_to: string, code: string) { sent = code; } },
    userId,
    'buyer@example.test',
  );
  return { cache, code: sent };
}

describe('the development email code', () => {
  it('is pinned to 111111 by default, so a claim needs no inbox', async () => {
    delete process.env.DEV_EMAIL_CODE;
    const { code } = await issue();
    assert.equal(code, '111111');
  });

  it('honours an explicit six-digit override', async () => {
    process.env.DEV_EMAIL_CODE = '654321';
    const { code } = await issue();
    assert.equal(code, '654321');
    delete process.env.DEV_EMAIL_CODE;
  });

  it('falls back to the CSPRNG for a value that is not six digits', async () => {
    // `random`, `off`, `12345`, an empty string — anything unparseable means
    // "do the real thing" rather than "pin to something surprising".
    for (const value of ['random', 'off', '12345', '1111111', '']) {
      process.env.DEV_EMAIL_CODE = value;
      const { code } = await issue();
      assert.match(code, /^\d{6}$/, `for DEV_EMAIL_CODE=${JSON.stringify(value)}`);
      assert.notEqual(code, '111111');
    }
    delete process.env.DEV_EMAIL_CODE;
  });

  it('is still checked, not merely announced', async () => {
    // The point of minting a known code is that nothing downstream changes:
    // a wrong code is still refused and a right one is still spent.
    delete process.env.DEV_EMAIL_CODE;
    const { cache, code } = await issue();
    assert.equal(code, '111111');

    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', '222222')).ok, false);
    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', code)).ok, true);
    // Spent: the same code cannot be replayed.
    assert.equal((await verifyEmailChallenge(cache, userId, 'buyer@example.test', code)).ok, false);
  });

  it('is ignored in production, even when the variable is set', () => {
    // `secretsAreProduction` is read once at import, so this has to be a fresh
    // process rather than a reassignment. It is the test that matters most:
    // everything else here is convenience, and this is the guard.
    const script = `
      process.env.NODE_ENV = 'production';
      process.env.DEV_EMAIL_CODE = '111111';
      process.env.AUTH_SECRET = 'a'.repeat(48);
      process.env.INTERNAL_TOKEN = 'b'.repeat(48);
      const { issueEmailChallenge } = await import('./src/api/claims.js');
      const { MemoryCache } = await import('./src/cache/index.js');
      let sent = '';
      await issueEmailChallenge(
        new MemoryCache(),
        { kind: 'logging', async send(_t, c) { sent = c; } },
        'u', 'buyer@example.test',
      );
      console.log(sent === '111111' ? 'PINNED' : 'RANDOM');
    `;
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    assert.equal(out.trim().split('\n').pop(), 'RANDOM');
  });
});
