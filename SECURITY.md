# Security

*The checkout threat model, the controls that implement it, and what is still open.*

Window's checkout spends real money on merchant sites the user has no account
with, driven by an agent reading pages we do not control. That shape decides
what this document has to cover: the money path, the identity that authorizes
it, and the boundary between merchant-controlled content and anything that acts
on it.

## The one invariant

**Nothing is ever bought at a price the user did not see and approve.**

Everything below either implements that or protects the identity that gives it
meaning. It is enforced in four places, each of which independently stops a
purchase:

| Control | Where | What it refuses |
| --- | --- | --- |
| Quote hash | `checkout/orchestrator.ts` | An authorization whose `quoteHash` differs by a single cent from the quote shown. 409, nothing placed. |
| Quote expiry | `checkout/orchestrator.ts` | An authorization against a quote older than 10 minutes. 409, re-quote required. |
| Submission claim | `orders.findOneAndUpdate({ submissionSeq: 0 })` | A second submission of the same job, under a distributed lock taken before any state change. |
| Amount cap | `checkout/payments.ts` | A capture above the authorized total plus 2%. Refused by the rail, not by our code — so it holds even if our code is wrong. |

The hash covers subtotal, shipping, tax, discount, total, currency and the
exact product set, not just the total. A merchant that swaps a line for an
identically-priced one produces a different hash and a 409.

## Identity

The privilege boundary is `isAnonymous`. An anonymous principal can do
everything except place orders and link merchant accounts — there is no sign-in
wall before the feed, deliberately. That makes the claim path the only
privilege escalation in the system, and the device credential the only thing
standing between an attacker and someone else's cart and order history.

**Device secret.** Minted server-side from 32 CSPRNG bytes, returned exactly
once, stored only as a SHA-256 hash. A presented secret may only *resume* an
identity, never create one under a chosen name: an unrecognised secret yields a
new empty profile. Guessing therefore gains nothing, and a dump of the `users`
collection authenticates as nobody.

`deviceUserId` is a public handle. It is safe to log, return and display, and
it is not accepted as a credential.

**Session tokens.** HMAC-SHA256 over a versioned payload carrying `sub`, `aud`,
`iat`, `exp` and a session epoch. Signature comparison is constant-time.
Expiry is 30 days; the client silently re-derives from the device secret on a
401, so a returning user never sees a sign-in prompt they never signed into.

Two things are settled against the database on every request rather than read
from the token:

- **The epoch.** `POST /v1/me/sessions/revoke` increments it, invalidating every
  token already issued. Without this, "sign out" only clears local storage.
- **The privilege level.** `isAnonymous` is computed from `user.auth`, never
  from the token's own claim. A bearer token is an assertion by the holder about
  the holder; the check that decides whether money may move cannot take it.

**Claiming.** Email requires a six-digit CSPRNG code, hashed at rest, bound to
the address it was sent to, single-use, five attempts, ten minutes. Apple and
Google are refused until a JWKS verifier is configured — the same rule the
payment rail follows, because a verification step that pretends to work is worse
than an absent one. A successful claim regenerates the session, so the
lower-trust token minted before it stops opening the higher-trust account.

The claim response is identical whether or not the address already belongs to
another account. Telling the caller "that email is taken" is an oracle for who
has a Window account, bought for no security benefit.

## The agent boundary

The checkout agent reads pages written by parties who would like to be paid more
than the user agreed to. It is contained structurally rather than by asking it
nicely:

- **A closed tool set.** Seven tools — navigate, click, type, select, read DOM,
  screenshot, request user input. An agent that can only do these seven things
  cannot be talked into an eighth.
- **No authority over the amount.** The agent never sees the payment token, only
  an opaque handle scoped to one job and one merchant, capped at the authorized
  total plus 2%. Page text that convinces the agent to pay more produces a
  refused capture and a failed job.
- **No authority over authorization.** The agent stops at `awaiting_auth` and
  cannot cross it. Only an HTTP request echoing the exact quote hash can.
- **Never handles a one-time code.** CAPTCHA, 2FA and 3-D Secure are handed to
  the user. This is why authorization is passkey-based rather than OTP: the
  agent must never be in a position to read a code.
- **Redacted audit.** Tool calls are recorded with selectors and URLs intact and
  typed values reduced to a type and a length. "The agent entered a 14-character
  value into `#phone`" answers the dispute question; the phone number does not.

## Injection

MongoDB's query and update languages are data. A string in a query position is
inert; an object is a program. `api/validation.ts` is the boundary where
untrusted JSON stops being able to become either.

- Every path-parameter id goes through `idParam`, which validates 24-hex before
  constructing an `ObjectId`. Constructing first throws a `BSONError` that can
  only be rendered as a 500 — a bad request reported as a server fault, with a
  stack logged for every probe.
- User-supplied map keys (`variant`) are bounded in count, key length and value
  length, and rejected if they begin with `$`, contain `.`, or name a prototype
  property.
- Bodies carrying `__proto__`, `constructor` or `prototype` at any depth are
  refused before a handler sees them.
- Merchant domains in path parameters must be bare hostnames, because they are
  interpolated into a link URL the client is told to open.

## Browser-facing

These do not defend the API against an attacker; they defend the browser against
the API.

`nosniff` (the media origin serves third-party bytes — a sniffed `text/html`
there is stored XSS on our own origin), `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, a `default-src 'none'; sandbox` CSP, a
`Permissions-Policy` denying camera/mic/geolocation/payment, and HSTS once the
connection is already secure.

CORS is an explicit allowlist (`CORS_ORIGINS`). The previous `*` was survivable
only because auth is a bearer header rather than a cookie — one design decision
away from being every origin's API.

Media content types come from a magic-byte probe, never from the remote
server's `Content-Type`, and storage keys are regex-validated before they reach
a path join.

## Rate limits and proxy trust

`trust proxy` is an explicit hop count, not `true`. With `true`, Express reads
`req.ip` from a header the client writes — and `req.ip` is the rate-limit key on
exactly the unauthenticated credential routes that most need one. Set
`TRUST_PROXY_HOPS` to the number of proxies actually in front of the process.

Buckets: feed 120/min, events 600/min, quotes 20/hr, merchant links 5/day,
device bootstrap 30/hr per IP, claims 10/hr, authorizations 30/hr.

## SSE credentials

`EventSource` cannot set an `Authorization` header, so the stream URL carries
its own credential — and a URL is the worst place in the system for one: access
logs, proxy logs, `Referer`, browser history. It therefore carries a *ticket*,
not the session token: one job, one minute, one use, minted over an
authenticated POST and burned on redemption. A ticket recovered from a log has
already been spent.

## Secrets

`AUTH_SECRET` and `INTERNAL_TOKEN` are required in production and the process
refuses to boot without them. Outside production an ephemeral value is generated
per process and announced on stderr — ephemeral rather than a fixed literal,
because a development default is a credential that leaks into commits,
screenshots and `docker inspect` output.

`INTERNAL_TOKEN` is compared with `timingSafeEqual`. String `!==` returns at the
first differing byte, which is a byte oracle; the endpoint behind it dumps
per-user ranking state for an arbitrary user id and rewrites the scoring weights
for everyone.

## Deployment requirements

Controls that live outside this repository and must be true of the deployment:

1. **`/internal` must not be publicly routable.** It requires a real secret, but
   defence in depth means the load balancer should not route `/internal/*` from
   the internet at all.
2. **`TRUST_PROXY_HOPS` must match reality.** Too high re-opens IP spoofing; too
   low rate-limits every user behind the balancer as one principal.
3. **TLS terminates before this process.** HSTS is asserted only on an
   already-secure connection.
4. **`CORS_ORIGINS` must be set.** It defaults to empty in production.
5. **A `Mailer` must be wired** before the email claim path is enabled;
   `createMailer()` throws in production rather than accepting unverifiable
   claims.

## Known gaps

Named rather than quietly carried:

- **OAuth claims are refused, not verified.** `UnconfiguredOidcVerifier` needs a
  JWKS client checking signature, issuer, audience, expiry and nonce.
- **The device secret is in AsyncStorage on native.** That is an unencrypted
  file in the app sandbox. `expo-secure-store` (Keychain/Keystore) is a drop-in
  for the same two-method interface and is the right home for a credential.
- **Media ingestion fetches attacker-influenced URLs.** `FetchedMediaPipeline`
  fetches whatever a source feed lists, which is an SSRF reach into anything the
  ingest host can route to. It is an operator-run CLI rather than a request
  path, but it wants an allowlist and a link-local/private-range deny.
- **Merchant session cookies are typed as encrypted, not encrypted.**
  `MerchantLinkDoc.encryptedSession` has the right shape and no implementation;
  the linking flow is a stub.
- **Existing user documents predating the device secret cannot be resumed.**
  The index is sparse and the lookup misses, so they get a new anonymous
  profile. That is fail-closed and correct, and it is a data migration for any
  deployment that already has users.
- **No CSRF tokens**, which is correct while auth is a bearer header and there
  are no cookies. Introducing a cookie makes this a gap.

## Running the checks

```bash
npm test
```

154 tests, of which 34 in `packages/server/src/api/security.test.ts` cover the
controls above. Each is written as the attack it refuses rather than the
behaviour it permits: a test that only proves the happy path passes equally
well against a system with the check deleted.

```bash
npm run smoke -w @window/server
```

End-to-end against a running server, including that an unrecognised device
secret cannot resume an identity, that a claim without a challenge is refused,
that a verification code cannot be replayed, and that the pre-claim token is
revoked by the privilege change.
