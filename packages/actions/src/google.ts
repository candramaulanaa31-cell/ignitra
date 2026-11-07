import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { SafeHttpClient } from "@ignitra/core";

/**
 * Google OAuth 2.0 (authorization code, offline access) for GOOGLE_SHEETS.
 * The refresh token is stored encrypted in a `google` connection; access
 * tokens live in memory only and are refreshed when they expire.
 */

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must be registered in the Google Cloud console, e.g. https://app.example/api/v1/connections/google/callback */
  readonly redirectUri: string;
  readonly authUrl?: string;
  readonly tokenUrl?: string;
  readonly sheetsUrl?: string;
}

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"] as const;

export class GoogleAuthError extends Error {
  /** The grant is gone (revoked, expired): the user must reconnect. */
  readonly revoked: boolean;

  constructor(message: string, revoked: boolean) {
    super(message);
    this.name = "GoogleAuthError";
    this.revoked = revoked;
  }
}

const tokenUrl = (cfg: GoogleConfig) => cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";

export function googleAuthUrl(cfg: GoogleConfig, state: string): string {
  const url = new URL(cfg.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // always return a refresh token
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

// ---- state: binds the callback to the signed-in user (CSRF), expires in 10 min ----

const stateKey = (master: string) => Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from("ignitra:oauth-state:v1"), Buffer.alloc(0), 32));

export function signOAuthState(master: string, userId: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, n: randomBytes(12).toString("base64url"), e: now + 600_000 })).toString("base64url");
  return `${body}.${createHmac("sha256", stateKey(master)).update(body).digest("base64url")}`;
}

export function verifyOAuthState(master: string, state: string, userId: string, now = Date.now()): boolean {
  const [body, mac] = state.split(".");
  if (!body || !mac) return false;
  const expected = Buffer.from(createHmac("sha256", stateKey(master)).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; e?: unknown };
    return parsed.u === userId && typeof parsed.e === "number" && parsed.e > now;
  } catch {
    return false;
  }
}

// ---- tokens ------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(http: SafeHttpClient, cfg: GoogleConfig, form: Record<string, string>): Promise<TokenResponse> {
  const res = await http.request({
    url: tokenUrl(cfg),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }).toString(),
  });
  let json: TokenResponse = {};
  try {
    json = JSON.parse(res.body) as TokenResponse;
  } catch {
    // ignore
  }
  if (res.status >= 400 || !json.access_token) {
    const revoked = json.error === "invalid_grant" || json.error === "unauthorized_client";
    throw new GoogleAuthError(`Google token endpoint: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`, revoked);
  }
  return json;
}

/** Email claim of the ID token returned directly by the token endpoint (TLS-authenticated; no signature check needed). */
function idTokenEmail(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(http: SafeHttpClient, cfg: GoogleConfig, code: string): Promise<{ refreshToken: string; email: string | null; scopes: string[] }> {
  const json = await tokenRequest(http, cfg, { code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri });
  if (!json.refresh_token) throw new GoogleAuthError("Google returned no refresh token; remove IGNITRA from your Google account's third-party access and connect again", false);
  const scopes = (json.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes("https://www.googleapis.com/auth/spreadsheets")) {
    throw new GoogleAuthError("the Google Sheets permission was not granted; connect again and allow access to spreadsheets", false);
  }
  return { refreshToken: json.refresh_token, email: idTokenEmail(json.id_token), scopes };
}

/** Access tokens per connection, refreshed a minute before they expire. In memory only. */
export class GoogleTokenCache {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();

  async get(http: SafeHttpClient, cfg: GoogleConfig, connectionId: string, refreshToken: string, now = Date.now()): Promise<string> {
    const hit = this.#tokens.get(connectionId);
    if (hit && hit.expiresAt - 60_000 > now) return hit.token;
    const json = await tokenRequest(http, cfg, { refresh_token: refreshToken, grant_type: "refresh_token" });
    const token = json.access_token as string;
    this.#tokens.set(connectionId, { token, expiresAt: now + (json.expires_in ?? 3600) * 1000 });
    return token;
  }

  invalidate(connectionId: string): void {
    this.#tokens.delete(connectionId);
  }
}

/** Spreadsheet id from a pasted URL (…/spreadsheets/d/<id>/edit) or the bare id. */
export function spreadsheetId(input: string): string | null {
  const v = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(v);
  if (m?.[1]) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(v) ? v : null;
}
