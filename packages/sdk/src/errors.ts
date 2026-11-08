/** Everything the SDK throws extends this. */
export class IgnitraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IgnitraError";
  }
}

export interface ApiIssue {
  path: string;
  message: string;
}

/**
 * The API answered with an error: `{ "error": { "code", "message", … } }`.
 *   400 malformed · 401 not signed in / bad key · 402 plan limit · 403 not allowed
 *   404 not found (or not yours) · 409 conflict · 422 invalid (see `issues`) · 429 rate limited
 */
export class IgnitraApiError extends IgnitraError {
  readonly status: number;
  readonly code: string;
  /** 422: one entry per problem, e.g. `{ path: "actions.0.params.url", message: "…" }`. */
  readonly issues: ApiIssue[];
  /** Everything else the error carried (e.g. `limit`, `plan`, `max` on a 402). */
  readonly details: Record<string, unknown>;
  /** 429 and some 503s: seconds to wait. */
  readonly retryAfter: number | null;

  constructor(status: number, body: unknown, retryAfter: number | null) {
    const error = (typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : null) as Record<string, unknown> | null;
    const code = typeof error?.code === "string" ? error.code : `http_${status}`;
    const message = typeof error?.message === "string" ? error.message : `the API answered HTTP ${status}`;
    super(`${message} (${code})`);
    this.name = "IgnitraApiError";
    this.status = status;
    this.code = code;
    this.issues = Array.isArray(error?.issues) ? (error.issues as ApiIssue[]) : [];
    const { code: _c, message: _m, issues: _i, ...rest } = error ?? {};
    this.details = rest;
    this.retryAfter = retryAfter;
  }
}

/** The request never got an answer: network failure or timeout. */
export class IgnitraNetworkError extends IgnitraError {
  readonly timedOut: boolean;

  constructor(message: string, timedOut: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "IgnitraNetworkError";
    this.timedOut = timedOut;
  }
}

/** A webhook did not carry a valid IGNITRA signature (or is too old to trust). */
export class IgnitraSignatureError extends IgnitraError {
  constructor() {
    super("the webhook signature is not valid");
    this.name = "IgnitraSignatureError";
  }
}
