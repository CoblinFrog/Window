/**
 * RFC 9457 problem details with a stable `type` URI, as the API contract requires.
 */

export const PROBLEM_BASE = 'https://window.app/problems';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Echoed so a client can correlate with server traces. */
  traceId?: string;
  [key: string]: unknown;
}

export const PROBLEM_TYPES = {
  validation: `${PROBLEM_BASE}/validation-failed`,
  unauthorized: `${PROBLEM_BASE}/unauthorized`,
  forbidden: `${PROBLEM_BASE}/forbidden`,
  notFound: `${PROBLEM_BASE}/not-found`,
  rateLimited: `${PROBLEM_BASE}/rate-limited`,
  quoteMismatch: `${PROBLEM_BASE}/quote-mismatch`,
  quoteExpired: `${PROBLEM_BASE}/quote-expired`,
  jobStateConflict: `${PROBLEM_BASE}/job-state-conflict`,
  anonymousNotAllowed: `${PROBLEM_BASE}/anonymous-not-allowed`,
  checkoutBlocked: `${PROBLEM_BASE}/checkout-blocked`,
  auctionNotPurchasable: `${PROBLEM_BASE}/auction-not-purchasable`,
  offline: `${PROBLEM_BASE}/offline`,
  internal: `${PROBLEM_BASE}/internal-error`,
} as const;

export class ApiError extends Error {
  readonly type: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extra: Record<string, unknown>;

  constructor(
    type: string,
    status: number,
    title: string,
    detail?: string,
    extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }

  toProblem(traceId?: string, instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
      ...this.extra,
    };
    if (this.detail) problem.detail = this.detail;
    if (instance) problem.instance = instance;
    if (traceId) problem.traceId = traceId;
    return problem;
  }

  static validation(detail: string, extra?: Record<string, unknown>): ApiError {
    return new ApiError(PROBLEM_TYPES.validation, 400, 'Validation failed', detail, extra);
  }
  static unauthorized(detail = 'A bearer token is required.'): ApiError {
    return new ApiError(PROBLEM_TYPES.unauthorized, 401, 'Unauthorized', detail);
  }
  static forbidden(detail: string): ApiError {
    return new ApiError(PROBLEM_TYPES.forbidden, 403, 'Forbidden', detail);
  }
  static notFound(what: string): ApiError {
    return new ApiError(PROBLEM_TYPES.notFound, 404, 'Not found', `${what} was not found.`);
  }
  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      PROBLEM_TYPES.rateLimited,
      429,
      'Rate limited',
      'Too many requests for this principal.',
      { retryAfter: retryAfterSeconds },
    );
  }
  static anonymousNotAllowed(action: string): ApiError {
    return new ApiError(
      PROBLEM_TYPES.anonymousNotAllowed,
      403,
      'Account required',
      `An anonymous principal cannot ${action}.`,
    );
  }
  static internal(detail = 'An unexpected error occurred.'): ApiError {
    return new ApiError(PROBLEM_TYPES.internal, 500, 'Internal error', detail);
  }
}
