import { create } from 'zustand';
import {
  CHECKOUT_CONFIG,
  PROBLEM_TYPES,
  type CheckoutJobSummary,
  type CheckoutStreamPayload,
  type OrderStatus,
} from '@window/shared';
import { ApiRequestError, api } from '../api/client.js';
import { emit } from './events.js';

/**
 * Checkout job lifecycle.
 *
 * One cart decomposes into one job per merchant, and every job here is tracked
 * independently for the whole of its life. There is deliberately no aggregate
 * status and no "all done" flag: a split cart that half-succeeds is the normal
 * case, not the edge case, and a single roll-up would be a lie the moment one
 * merchant failed.
 *
 * Transport: SSE where the platform has `EventSource`, polling everywhere else.
 * React Native has no `EventSource`, so polling is the native path rather than
 * a degraded one — and because the stream endpoint is authenticated with a
 * bearer header that `EventSource` cannot send, a web stream that fails to
 * open is also expected to land on the poll loop rather than error out.
 */

/** Past these the job is done writing to itself and the watcher can stop. */
const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'placed',
  'failed',
  'cancelled',
]);

/** `uncertain` is not terminal: a verification pass re-checks the merchant. */
function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

export type JobTransport = 'stream' | 'poll';

export interface CouponAttempt {
  code: string;
  ok: boolean;
  discount: number;
  reason?: string;
}

export type AuthorizeOutcome =
  | { kind: 'placed' }
  | { kind: 'running' }
  /** 409. Nothing was placed; the quote has to be re-run. */
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

interface Watcher {
  source: EventSource | null;
  timer: ReturnType<typeof setTimeout> | null;
  overdue: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * Watchers live outside the store, the way the feed keeps its in-flight page
 * promise outside: they are connections, not state, and putting them in the
 * store would make every step event re-render on an identity change.
 */
const watchers = new Map<string, Watcher>();

/** A job whose `purchase` signal has already been raised. One per job, ever. */
const purchaseEmitted = new Set<string>();

function stopWatcher(jobId: string): void {
  const watcher = watchers.get(jobId);
  if (!watcher) return;
  watcher.stopped = true;
  watcher.source?.close();
  if (watcher.timer) clearTimeout(watcher.timer);
  if (watcher.overdue) clearTimeout(watcher.overdue);
  watchers.delete(jobId);
}

function conflictMessage(error: ApiRequestError): string {
  switch (error.problem?.type) {
    case PROBLEM_TYPES.quoteExpired:
      return 'That quote expired before it was authorized. Nothing was placed. Re-run the quote to see current prices.';
    case PROBLEM_TYPES.quoteMismatch:
      return 'The totals changed between the quote you saw and this tap. Nothing was placed. Re-run the quote to see the new numbers.';
    case PROBLEM_TYPES.jobStateConflict:
      return 'This job is no longer waiting for authorization. Nothing was placed.';
    default:
      return `${error.message} Nothing was placed.`;
  }
}

export interface CheckoutState {
  /** Stable order, so cards do not reshuffle as jobs report. */
  jobIds: string[];
  jobs: Record<string, CheckoutJobSummary>;
  /** Live agent steps per job, newest last. */
  steps: Record<string, string[]>;
  couponAttempts: Record<string, CouponAttempt[]>;
  transport: Record<string, JobTransport>;
  /** Jobs that have outlived the 180 s agent budget. */
  overdue: Record<string, boolean>;
  authorizing: Record<string, boolean>;
  /** 409 copy per job. Set means: nothing was placed. */
  conflict: Record<string, string | null>;
  jobError: Record<string, string | null>;
  cancelling: Record<string, boolean>;

  phase: 'idle' | 'quoting' | 'ready' | 'error';
  error: string | null;

  start(): Promise<void>;
  authorize(jobId: string): Promise<AuthorizeOutcome>;
  cancel(jobId: string): Promise<void>;
  answerPrompt(jobId: string, promptId: string, value: string): Promise<void>;
  refresh(jobId: string): Promise<void>;
  /** Closes every stream and clears every timer. Call on unmount. */
  teardown(): void;
  reset(): void;

  quoteExpiresAt(jobId: string): number | null;
  isAuthorizable(jobId: string, now: number): boolean;
}

const MAX_STEPS = 40;

export const useCheckout = create<CheckoutState>((set, get) => ({
  jobIds: [],
  jobs: {},
  steps: {},
  couponAttempts: {},
  transport: {},
  overdue: {},
  authorizing: {},
  conflict: {},
  jobError: {},
  cancelling: {},
  phase: 'idle',
  error: null,

  /**
   * Creates the jobs and starts watching each one. Re-runnable: this is also
   * the re-quote path after a 409, which is why it tears everything down first
   * rather than merging into whatever was on screen.
   */
  async start() {
    get().teardown();
    set({
      phase: 'quoting',
      error: null,
      jobIds: [],
      jobs: {},
      steps: {},
      couponAttempts: {},
      transport: {},
      overdue: {},
      authorizing: {},
      conflict: {},
      jobError: {},
      cancelling: {},
    });

    try {
      const response = await api.quote();
      const jobs: Record<string, CheckoutJobSummary> = {};
      for (const job of response.jobs) jobs[job.jobId] = job;
      set({
        phase: 'ready',
        jobIds: response.jobs.map((job) => job.jobId),
        jobs,
      });
      for (const job of response.jobs) void watch(job.jobId, set, get);
    } catch (error) {
      set({ phase: 'error', error: (error as Error).message });
    }
  },

  /**
   * The authorization contract.
   *
   * The exact `quoteHash` from the quote the user read goes back up. A 409
   * means mismatch, expiry or wrong state, and nothing was placed — so the
   * conflict is stored as copy rather than swallowed into a retry.
   */
  async authorize(jobId) {
    const job = get().jobs[jobId];
    const quote = job?.quote;
    if (!quote) {
      return { kind: 'error', message: 'There is no quote to authorize yet.' };
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      const message =
        'This quote has expired. Re-run it to see current prices before authorizing.';
      set({ conflict: { ...get().conflict, [jobId]: message } });
      return { kind: 'conflict', message };
    }

    set({
      authorizing: { ...get().authorizing, [jobId]: true },
      conflict: { ...get().conflict, [jobId]: null },
      jobError: { ...get().jobError, [jobId]: null },
    });

    try {
      const updated = await api.authorize(jobId, { quoteHash: quote.hash });
      mergeJob(updated, set, get);
      set({ authorizing: { ...get().authorizing, [jobId]: false } });
      // The job may still be `placing`; the watcher carries it the rest of the way.
      if (!watchers.has(jobId) && !isTerminal(updated.status)) void watch(jobId, set, get);
      return updated.status === 'placed' ? { kind: 'placed' } : { kind: 'running' };
    } catch (error) {
      set({ authorizing: { ...get().authorizing, [jobId]: false } });
      if (error instanceof ApiRequestError && error.isConflict) {
        const message = conflictMessage(error);
        set({ conflict: { ...get().conflict, [jobId]: message } });
        return { kind: 'conflict', message };
      }
      const message = (error as Error).message;
      set({ jobError: { ...get().jobError, [jobId]: message } });
      return { kind: 'error', message };
    }
  },

  /**
   * Cancel is a first-class flow, not an afterthought. A 409 here means the
   * agent already submitted, and saying so is the only honest answer.
   */
  async cancel(jobId) {
    set({ cancelling: { ...get().cancelling, [jobId]: true } });
    try {
      const updated = await api.cancelJob(jobId);
      mergeJob(updated, set, get);
    } catch (error) {
      if (error instanceof ApiRequestError && error.isConflict) {
        set({
          conflict: {
            ...get().conflict,
            [jobId]: 'Too late to cancel — this job has already been submitted to the merchant.',
          },
        });
        void get().refresh(jobId);
      } else {
        set({ jobError: { ...get().jobError, [jobId]: (error as Error).message } });
      }
    } finally {
      set({ cancelling: { ...get().cancelling, [jobId]: false } });
    }
  },

  async answerPrompt(jobId, promptId, value) {
    try {
      await api.answerPrompt(jobId, { promptId, value });
      // The answer is accepted with a 202; the job's own next frame carries the
      // result, so the prompt is cleared optimistically to stop double sends.
      const job = get().jobs[jobId];
      if (job) mergeJob({ ...job, needsInput: null }, set, get);
    } catch (error) {
      set({ jobError: { ...get().jobError, [jobId]: (error as Error).message } });
    }
  },

  async refresh(jobId) {
    try {
      mergeJob(await api.job(jobId), set, get);
    } catch {
      // The watcher retries on its own cadence; a failed poll is not an error
      // the user needs to read.
    }
  },

  teardown() {
    for (const jobId of [...watchers.keys()]) stopWatcher(jobId);
  },

  reset() {
    get().teardown();
    purchaseEmitted.clear();
    set({
      jobIds: [],
      jobs: {},
      steps: {},
      couponAttempts: {},
      transport: {},
      overdue: {},
      authorizing: {},
      conflict: {},
      jobError: {},
      cancelling: {},
      phase: 'idle',
      error: null,
    });
  },

  quoteExpiresAt(jobId) {
    const expiresAt = get().jobs[jobId]?.quote?.expiresAt;
    return expiresAt ? Date.parse(expiresAt) : null;
  },

  isAuthorizable(jobId, now) {
    const job = get().jobs[jobId];
    if (!job?.quote) return false;
    if (job.status !== 'awaiting_auth') return false;
    if (job.needsInput) return false;
    if (get().authorizing[jobId]) return false;
    return Date.parse(job.quote.expiresAt) > now;
  },
}));

type Setter = (partial: Partial<CheckoutState>) => void;
type Getter = () => CheckoutState;

/**
 * Folds a job summary in.
 *
 * Also the one place the `purchase` signal is raised, and only on an observed
 * `placed` — not on the authorization tap, which is a request rather than an
 * outcome, and not on `uncertain`, which is the state that exists precisely
 * because we do not know yet.
 */
function mergeJob(job: CheckoutJobSummary, set: Setter, get: Getter): void {
  set({ jobs: { ...get().jobs, [job.jobId]: job } });

  if (job.status === 'placed' && !purchaseEmitted.has(job.jobId)) {
    purchaseEmitted.add(job.jobId);
    for (const item of job.items) {
      emit('purchase', { productId: item.productId, position: -1, mode: 'single' });
    }
  }
  if (isTerminal(job.status)) stopWatcher(job.jobId);
}

function pushStep(jobId: string, step: string, set: Setter, get: Getter): void {
  const existing = get().steps[jobId] ?? [];
  set({ steps: { ...get().steps, [jobId]: [...existing, step].slice(-MAX_STEPS) } });
}

function pushCoupon(jobId: string, attempt: CouponAttempt, set: Setter, get: Getter): void {
  const existing = get().couponAttempts[jobId] ?? [];
  set({
    couponAttempts: {
      ...get().couponAttempts,
      [jobId]: [...existing, attempt].slice(-CHECKOUT_CONFIG.maxCouponAttempts),
    },
  });
}

/**
 * The first SSE frame the server writes is a full job summary under the `state`
 * event name; every later frame is a `CheckoutStreamPayload`. Both arrive on
 * the same channel, so the shape is discriminated rather than assumed.
 */
function applyFrame(jobId: string, raw: string, set: Setter, get: Getter): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;

  if (!('event' in parsed)) {
    mergeJob(parsed as CheckoutJobSummary, set, get);
    return;
  }

  const payload = parsed as CheckoutStreamPayload;
  const job = get().jobs[jobId];

  switch (payload.event) {
    case 'state':
      if (job && payload.state) mergeJob({ ...job, status: payload.state }, set, get);
      // A state arriving for a job we have not seen yet is not something to
      // drop: it is the first thing we know about it.
      else if (payload.state) void get().refresh(jobId);
      break;
    case 'step':
      if (payload.step) pushStep(jobId, payload.step, set, get);
      break;
    case 'coupon_attempt':
      if (payload.couponAttempt) pushCoupon(jobId, payload.couponAttempt, set, get);
      break;
    case 'needs_input':
      if (job && payload.needsInput) {
        mergeJob({ ...job, needsInput: payload.needsInput }, set, get);
      }
      break;
    case 'quote_ready':
      // The server signals that quoting finished; it does not necessarily carry
      // the summary with it. Merging only when `quote` is present means the one
      // event that ends the waiting state gets silently dropped, and the screen
      // sits on "Working at the merchant" while the job is long since done.
      if (payload.quote) mergeJob(payload.quote, set, get);
      else void get().refresh(jobId);
      break;
  }
}

async function watch(jobId: string, set: Setter, get: Getter): Promise<void> {
  stopWatcher(jobId);
  const watcher: Watcher = { source: null, timer: null, overdue: null, stopped: false };
  watchers.set(jobId, watcher);

  // The agent's own ceiling is 180 s. Past it the job is late; the server is
  // what decides it has failed, so this only labels, it never concludes.
  watcher.overdue = setTimeout(() => {
    if (!watcher.stopped) set({ overdue: { ...get().overdue, [jobId]: true } });
  }, CHECKOUT_CONFIG.jobTimeoutMs);

  const startPolling = (): void => {
    if (watcher.stopped) return;
    set({ transport: { ...get().transport, [jobId]: 'poll' } });

    const tick = async (): Promise<void> => {
      if (watcher.stopped) return;
      try {
        const job = await api.job(jobId);
        if (watcher.stopped) return;
        mergeJob(job, set, get);
        if (isTerminal(job.status)) return;
      } catch {
        // Keep the cadence. A dropped poll is not a failed job, and the screen
        // must not invent one.
      }
      if (watcher.stopped) return;
      watcher.timer = setTimeout(() => void tick(), CHECKOUT_CONFIG.pollIntervalMs);
    };

    watcher.timer = setTimeout(() => void tick(), CHECKOUT_CONFIG.pollIntervalMs);
  };

  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }

  // The ticket is fetched over an authenticated POST first, so the stream URL
  // carries a one-minute single-use credential rather than the session token.
  let streamUrl: string;
  try {
    streamUrl = await api.jobStreamUrl(jobId);
  } catch {
    // No ticket, no stream. Polling returns the identical shape, and a job the
    // user is waiting on must never be left with a dead transport.
    startPolling();
    return;
  }
  if (watcher.stopped) return;

  const source = new EventSource(streamUrl);
  watcher.source = source;
  set({ transport: { ...get().transport, [jobId]: 'stream' } });

  const onFrame = (event: MessageEvent<string>): void => {
    applyFrame(jobId, event.data, set, get);
  };
  for (const name of ['state', 'step', 'coupon_attempt', 'needs_input', 'quote_ready']) {
    source.addEventListener(name, onFrame as EventListener);
  }
  source.onmessage = onFrame;

  source.onerror = () => {
    if (watcher.stopped) return;
    // The ticket is single-use, so EventSource's own reconnect cannot succeed:
    // it would replay a spent credential forever. Close it and take the poll
    // path, which returns the identical shape — a job the user is waiting on
    // must never be left with a dead transport.
    source.close();
    watcher.source = null;
    startPolling();
  };

  // Poll once immediately either way, so a job that finished before the stream
  // attached still lands on screen.
  void get().refresh(jobId);
}
