import { connectDatabase } from '../db/index.js';
import { find, updateOne } from '../db/supabase-helpers.js';
import { logger } from '../lib/logger.js';
import type { User } from '../db/supabase-collections.js';

const log = logger.child('reset-onboarding');

/**
 * Clears the onboarding record so the topic picker runs again.
 *
 * Onboarding is shown exactly once, and the thing that decides is a single
 * stored field: the feed screen redirects while `user.onboarding` is null and
 * stops the moment it is not. There is no way back to that screen from inside
 * the app, so during development the only way to see it a second time is to
 * become a different anonymous user — which also abandons that user's cart,
 * upvotes and learned vector. This clears the one field instead.
 *
 * The interest vector is deliberately left alone. Completing onboarding
 * overwrites it along with the interest set, the price prior and the
 * exploration counter, so nothing stale survives a finished run — and if the
 * picker is abandoned halfway, the feed the user already had still works.
 *
 * A selector is required. Defaulting to every user would make an unqualified
 * run the destructive one, which is the wrong way round for a script whose
 * whole job is to throw away a choice someone made.
 *
 *   npm run reset:onboarding -w @window/server -- --device dev_abc123
 *   npm run reset:onboarding -w @window/server -- --user <uuid>
 *   npm run reset:onboarding -w @window/server -- --all --dry-run
 */

interface Args {
  deviceUserId: string | null;
  userId: string | null;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  return {
    deviceUserId: valueOf('--device'),
    userId: valueOf('--user'),
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.all && !args.deviceUserId && !args.userId) {
    log.error('nothing selected; pass --device <id>, --user <id> or --all');
    process.exit(1);
  }

  const db = await connectDatabase();

  const filter = args.userId
    ? { id: args.userId }
    : args.deviceUserId
      ? { deviceUserId: args.deviceUserId }
      : {};
  const users = await find<User>(db.collections.users, filter, { limit: 1000 });

  // Only the ones that have actually been through it: reporting a reset for a
  // user who was never onboarded would overstate what this did.
  const onboarded = users.filter((user) => user.onboarding !== null);

  for (const user of onboarded) {
    log.info(args.dryRun ? 'would clear' : 'clearing', {
      userId: user.id,
      deviceUserId: user.deviceUserId,
      topics: user.onboarding?.topics,
    });
    if (!args.dryRun) {
      await updateOne(db.collections.users, { id: user.id }, { onboarding: null, updatedAt: new Date() });
    }
  }

  log.info(args.dryRun ? 'reset (dry run)' : 'reset complete', {
    matched: users.length,
    cleared: onboarded.length,
  });

  await db.close();
}

main().catch((error) => {
  log.error('reset failed', { error: (error as Error).message });
  process.exit(1);
});
