import {
  L1_IDS,
  RAIL_INTERACTION_TYPES,
  TOPIC_ADOPTION,
  clamp,
  weightedPick,
  type CategoryDoc,
  type InteractionType,
  type InterestEntry,
  type RankingConfig,
  type UserDoc,
} from '@window/shared';

/**
 * Controlled discovery.
 *
 * A deliberate off-interest item appears every 10 to 20 cards and can graduate
 * into the user's interest set on its own merits. This is the single riskiest
 * assumption in the ranking design — an exploration card that reads as an ad
 * costs more trust than the discovery is worth — so everything here is built to
 * make the card as good as the topic can possibly look.
 */

export interface ExplorationCandidate {
  topic: string;
  /** How often users with this interest set also engage with the topic. */
  lift: number;
  /** The topic's median engagement rate, so no card comes from a weak catalog. */
  medianCtr: number;
  productCount: number;
}

/**
 * Samples an exploration topic from outside the interest set, weighted by
 * co-occurrence lift and global quality, with recently rejected topics
 * suppressed.
 */
export function chooseExplorationTopic(
  user: Pick<UserDoc, 'interestSet' | 'explorationState'>,
  categories: ReadonlyMap<string, CategoryDoc>,
  config: RankingConfig,
  random: () => number,
  now: Date,
): string | null {
  const interest = new Set(user.interestSet.map((entry) => entry.topic));
  const suppressed = new Set(
    user.explorationState.rejected
      .filter((r) => r.until.getTime() > now.getTime())
      .map((r) => r.topic),
  );

  // Co-occurrence lift is stored on the L1 category documents in the user's own
  // interest set, so the strongest interests drive what gets suggested.
  const liftByTopic = new Map<string, number>();
  for (const entry of user.interestSet) {
    const node = categories.get(entry.topic);
    if (!node) continue;
    for (const pair of node.coOccurrence ?? []) {
      if (interest.has(pair.topic)) continue;
      // Weighted by how much the user cares about the source interest.
      liftByTopic.set(
        pair.topic,
        (liftByTopic.get(pair.topic) ?? 0) + pair.lift * entry.weight,
      );
    }
  }

  const maxLift = Math.max(1, ...liftByTopic.values());
  const maxCtr = Math.max(
    0.001,
    ...[...categories.values()].filter((c) => c.level === 1).map((c) => c.engagement.medianCtr),
  );

  const candidates: Array<{ item: string; weight: number }> = [];
  for (const topic of L1_IDS) {
    if (interest.has(topic) || suppressed.has(topic)) continue;
    const node = categories.get(topic);
    if (!node) continue;
    // A topic with almost nothing in it cannot be presented at its best.
    if (node.engagement.productCount < 50) continue;

    const normalisedLift = (liftByTopic.get(topic) ?? 0) / maxLift;
    const normalisedQuality = node.engagement.medianCtr / maxCtr;
    const weight =
      config.exploration.liftWeight * normalisedLift +
      config.exploration.qualityWeight * normalisedQuality;

    // A floor keeps genuinely novel topics reachable: a topic with no measured
    // co-occurrence is unexplored, not unwanted.
    candidates.push({ item: topic, weight: Math.max(weight, 0.02) });
  }

  return weightedPick(candidates, random);
}

/** Redraws the counter uniformly from [10, 20] after an exploration card fires. */
export function drawExplorationCounter(config: RankingConfig, random: () => number): number {
  const { counterMin, counterMax } = config.exploration;
  return counterMin + Math.floor(random() * (counterMax - counterMin + 1));
}

/**
 * Where the exploration slots fall inside one page, and what is left of the
 * interval afterwards.
 *
 * The counter is decremented per card rendered, so a page is not one tick of
 * the interval — it is `limit` of them. Computing only the first expiry and
 * carrying the rest into the next page quietly pins every gap to a full page,
 * which at a 20-card page is the sparse end of the 10-to-20 range every single
 * time. A page has to be able to carry two slots for the range to mean anything.
 */
export function explorationSlotsForPage(
  counter: number,
  limit: number,
  config: RankingConfig,
  random: () => number,
): { positions: number[]; nextCounter: number } {
  const positions: number[] = [];
  let next = Math.max(0, counter);

  while (next < limit) {
    positions.push(next);
    next += drawExplorationCounter(config, random);
  }

  return { positions, nextCounter: Math.max(0, next - limit) };
}

/**
 * Records that a topic produced nothing. A topic rejected twice is suppressed
 * for 30 days — long enough that the user does not feel nagged, short enough
 * that a changing catalog gets another chance.
 */
export function recordExplorationRejection(
  state: UserDoc['explorationState'],
  topic: string,
  config: RankingConfig,
  now: Date,
): UserDoc['explorationState'] {
  const rejected = [...state.rejected];
  const existing = rejected.find((r) => r.topic === topic);
  const strikes = (existing?.strikes ?? 0) + 1;
  const until =
    strikes >= config.exploration.rejectionStrikes
      ? new Date(now.getTime() + config.exploration.suppressionDays * 24 * 60 * 60 * 1000)
      : now;

  if (existing) {
    existing.strikes = strikes;
    existing.until = until;
  } else {
    rejected.push({ topic, strikes, until });
  }

  return { ...state, rejected };
}

// ---------------------------------------------------------------------------
// Topic adoption
// ---------------------------------------------------------------------------

export interface AdoptionEvidence {
  topic: string;
  sessionId: string;
  type: InteractionType;
  dwellMs: number | null;
}

export interface AdoptionOutcome {
  /** Non-null when the topic graduated on this event. */
  graduated: { topic: string; weight: number } | null;
  explorationState: UserDoc['explorationState'];
}

/**
 * An exploration topic graduates into the interest set when, inside a rolling
 * three-session window, the user produces any of the configured triggers. The
 * granted weight is the strongest trigger that fired, and the topic enters at
 * that weight rather than at 1.0, so it competes for feed share without
 * displacing established interests.
 */
export function applyAdoptionEvidence(
  state: UserDoc['explorationState'],
  evidence: AdoptionEvidence,
  interestSet: readonly InterestEntry[],
): AdoptionOutcome {
  if (interestSet.some((entry) => entry.topic === evidence.topic)) {
    return { graduated: null, explorationState: state };
  }

  const pending = state.pending ?? [];
  const entry = pending.find((p) => p.topic === evidence.topic) ?? {
    topic: evidence.topic,
    sessions: [] as string[],
    positiveDwells: 0,
    bestDwellMs: 0,
    railInteraction: false,
    cartAdd: false,
  };

  // The window is three *sessions*, not three events: a single long session of
  // enthusiasm is weaker evidence than interest that survives coming back.
  if (!entry.sessions.includes(evidence.sessionId)) {
    entry.sessions = [...entry.sessions, evidence.sessionId].slice(-TOPIC_ADOPTION.sessionWindow);
  }

  const triggers = TOPIC_ADOPTION.triggers;

  if (evidence.dwellMs !== null) {
    entry.bestDwellMs = Math.max(entry.bestDwellMs, evidence.dwellMs);
    if (evidence.dwellMs > triggers.repeatDwell.thresholdMs) entry.positiveDwells += 1;
  }
  if (evidence.type === 'cart_add') entry.cartAdd = true;
  if (RAIL_INTERACTION_TYPES.includes(evidence.type)) entry.railInteraction = true;

  const weights: number[] = [];
  if (entry.cartAdd) weights.push(triggers.cartAdd.weight);
  if (entry.railInteraction) weights.push(triggers.rail.weight);
  if (entry.positiveDwells >= triggers.repeatDwell.count) weights.push(triggers.repeatDwell.weight);
  if (entry.bestDwellMs > triggers.dwell.thresholdMs) weights.push(triggers.dwell.weight);

  const nextPending = [...pending.filter((p) => p.topic !== evidence.topic), entry];

  if (weights.length === 0) {
    return { graduated: null, explorationState: { ...state, pending: nextPending } };
  }

  return {
    graduated: { topic: evidence.topic, weight: Math.max(...weights) },
    explorationState: {
      ...state,
      pending: nextPending.filter((p) => p.topic !== evidence.topic),
    },
  };
}

/**
 * A graduated topic is demoted back out if it accumulates no positive signal
 * across the next 40 impressions. Onboarding topics are never demoted: the user
 * chose them, and the feed does not get to overrule that.
 */
export function demoteStaleTopics(
  interestSet: readonly InterestEntry[],
): { kept: InterestEntry[]; demoted: string[] } {
  const kept: InterestEntry[] = [];
  const demoted: string[] = [];

  for (const entry of interestSet) {
    const isProvisional = entry.source === 'exploration';
    const impressions = entry.impressionsSinceAdded ?? 0;
    const positive = entry.positiveSinceAdded ?? 0;

    if (isProvisional && impressions >= TOPIC_ADOPTION.demotionImpressions && positive <= 0) {
      demoted.push(entry.topic);
      continue;
    }
    kept.push(entry);
  }

  return { kept, demoted };
}

/** Grants a graduated topic its entry weight. */
export function adoptTopic(
  interestSet: readonly InterestEntry[],
  topic: string,
  weight: number,
  now: Date,
): InterestEntry[] {
  if (interestSet.some((entry) => entry.topic === topic)) return [...interestSet];
  return [
    ...interestSet,
    {
      topic,
      weight: clamp(weight, 0, 1),
      source: 'exploration',
      addedAt: now,
      lastPositiveAt: now,
      impressionsSinceAdded: 0,
      positiveSinceAdded: 0,
    },
  ];
}
