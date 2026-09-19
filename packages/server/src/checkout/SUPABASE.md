# Checkout on Supabase — the contract

*What the checkout system needs from the database, and how to know when it works.*

Checkout touches **seven tables** and nothing else. No vector index, no ranking
state, no clusters, sellers, reviews or categories. You can build and verify
this slice on its own, before the rest of the migration exists.

## What to implement

One file: [`repository.ts`](repository.ts) defines `CheckoutRepository`. Write a
`SupabaseCheckoutRepository` implementing it. Everything above that interface —
the orchestrator, the cart, the routes, the authorization gate — is already
written and does not change.

Two rules the interface follows, and your implementation must too:

- **Ids are opaque strings.** The store issues them, callers only echo them
  back. `uuid` is fine; nothing above the interface knows or cares.
- **Missing rows return `null`, never an exception.** Callers turn `null` into a
  404 or a 409. A throw becomes a 500 on a perfectly ordinary request.

## Schema

Money is **integer minor units** everywhere — `1999` is $19.99. Never
`numeric`, never a float. The nested objects below are written and read whole,
never queried by inner field, so `jsonb` is the right call and keeps this small.

```sql
create table users (
  id                 uuid primary key default gen_random_uuid(),
  device_user_id     text not null unique,          -- public handle, not a credential
  device_secret_hash text unique,                   -- SHA-256 of the device secret
  session_epoch      int  not null default 1,       -- bump to revoke every token
  auth               jsonb,                         -- {email, providers, claimedAt, emailVerifiedAt}
  settings           jsonb not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index users_auth_email on users ((auth->>'email')) where auth->>'email' is not null;

create table carts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  status     text not null check (status in ('open','checking_out','closed')),
  items      jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
create unique index carts_one_open_per_user on carts (user_id) where status = 'open';

create table orders (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,               -- NOT a cascade: see below
  cart_id               uuid references carts(id),
  merchant_domain       text not null,
  items                 jsonb not null,
  quote                 jsonb,
  coupon                jsonb,
  authorization         jsonb,
  payment               jsonb,
  agent_run             jsonb,
  status                text not null check (status in
                          ('pending','quoting','awaiting_auth','placing',
                           'placed','uncertain','failed','cancelled')),
  merchant_order_number text,
  failure               jsonb,
  submission_seq        int not null default 0,      -- the replay guard
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index orders_by_user on orders (user_id, created_at desc);

create table sources (
  domain       text primary key,
  display_name text not null,
  source_type  text not null,
  checkout     jsonb not null                        -- {protocol, blocksAgents, stackableCoupons}
);

create table coupons (
  id              uuid primary key default gen_random_uuid(),
  merchant_domain text not null,
  code            text not null,
  discovered      jsonb not null,
  constraints     jsonb not null,
  performance     jsonb not null,
  stackable       boolean not null default false,
  status          text not null default 'active',
  unique (merchant_domain, code)
);

create table merchant_links (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  merchant_domain   text not null,
  status            text not null,
  encrypted_session jsonb,
  created_at        timestamptz not null default now(),
  linked_at         timestamptz,
  expires_at        timestamptz not null,
  unique (user_id, merchant_domain)
);
```

`products` is the seventh table and belongs to the catalog migration. Checkout
reads only `id`, `title`, `price`, `stock`, `risk`, `status`, `source_type`,
`source.domain` and `source.url`, so a handful of hand-inserted rows unblocks
all of this.

### Four constraints that are load-bearing

These are not tidiness. Each one is the enforcement of a security property the
application layer assumes:

| Constraint | Property it enforces |
| --- | --- |
| `users.device_secret_hash` **unique** | One secret resolves to one identity. Without it, the account-takeover fix is decorative. |
| unique index on `auth->>'email'` | One account per verified address. Without it, two accounts answer to one identity and neither can be safely merged. |
| `orders.submission_seq` default `0` | The single-submission guard. See below. |
| `carts` partial unique on `status='open'` | One open cart per user. The cart service assumes it and will otherwise silently pick an arbitrary one. |

**`orders.user_id` is deliberately not `on delete cascade.`** Account deletion
unlinks orders rather than deleting them — they are transaction records with
their own retention. Cascading here would delete them with the user.

## The one method that is easy to get wrong

`claimForSubmission` is the guard that makes one authorization produce at most
one order. It must be a **single atomic compare-and-set**. A `SELECT` followed
by an `UPDATE` is not an implementation of it, however carefully written:

```sql
update orders
   set status = 'placing', submission_seq = 1, authorization = $2,
       payment = $3, updated_at = now()
 where id = $1 and status = 'awaiting_auth' and submission_seq = 0
returning *;
```

Zero rows back means another caller won the race. **Return `null`, do not
throw** — contention is ordinary (a double-tap, a retried request, two tabs),
and the caller turns it into a 409.

`cancelOrder` and `reopenCart` are conditional for the same reason; their
`where` clauses are in the interface docs.

## How to know you are done

```ts
// repository.supabase.test.ts
import { describeCheckoutRepository } from './repository.conformance.js';

describeCheckoutRepository('supabase', async () => {
  const repo = new SupabaseCheckoutRepository(client);
  await repo.truncate();        // every case starts from empty
  return repo;
});
```

```bash
npm test -w @window/server
```

19 cases run against your implementation. They are written as the things that
must not happen, not as the happy path — cross-user reads, concurrent claims,
cancelling past the point of no return, dates surviving a round trip. All green
means the checkout system will work on your store.

The suite has been mutation-tested against the in-memory implementation: dropping
user scoping, making the claim a read-then-write, and returning a live reference
each fail exactly one case. It has teeth.

### Two failures worth predicting

- **`round-trips a quote with its dates intact`** — if `expiresAt` comes back as
  a string rather than a `Date`, every expired quote looks valid, because a
  string is never less than `Date.now()`. Parse `timestamptz` into `Date` on the
  way out.
- **`gives the order to exactly one of many concurrent claims`** — fails if
  `claimForSubmission` reads then writes. See above.

## RLS

The Express server holds the service-role key and every read is already scoped
by `user_id` in the repository, so RLS is defence in depth here rather than the
primary control. Enable it anyway — a policy of `user_id = auth.uid()` on
`carts`, `orders` and `merchant_links` costs nothing and means a future direct
client cannot read across users even by mistake.

**Checkout authorization must stay server-side regardless.** RLS can express
"this row is yours"; it cannot express "this update is permitted only if it
echoes a hash the user was shown less than ten minutes ago." That gate lives in
the orchestrator and does not move.

One trap worth naming: Supabase's JWT carries an `is_anonymous` claim. Do not
read it to decide whether someone may place an order — that is the holder
asserting their own privilege, which is the exact bug we just removed from the
old token. Privilege is read from the `users` row.
