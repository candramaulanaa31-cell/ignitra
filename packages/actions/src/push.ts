import { and, eq, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import type { Logger } from "pino";
import { newId, type PushDelivery, type PushMessage, type SafeHttpClient } from "@ignitra/core";
import { pushSubscriptions, type Database } from "@ignitra/db";
import { HttpTransportError, SsrfBlockedError, validateOutboundUrl } from "./http";

/**
 * Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID). `web-push` only BUILDS
 * the encrypted request; it is sent through the SSRF-guarded client like
 * every other outbound call.
 */

export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  /** mailto: or https: contact for push services. */
  readonly subject: string;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/** Fails fast (at startup) on malformed VAPID keys or subject, instead of on every delivery. */
export function assertVapid(vapid: VapidConfig): void {
  try {
    webpush.getVapidHeaders("https://push.example.com", vapid.subject, vapid.publicKey, vapid.privateKey, "aes128gcm");
  } catch (err) {
    throw new Error(`invalid VAPID configuration: ${(err as Error).message}`);
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export interface SubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export class PushSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushSubscriptionError";
  }
}

/** Validates and stores a browser subscription (PushSubscription.toJSON()). Re-subscribing the same endpoint updates it. */
export async function addPushSubscription(db: Database, userId: string, sub: SubscriptionInput, userAgent: string | null = null): Promise<string> {
  try {
    validateOutboundUrl(sub.endpoint, { allowHttp: false });
  } catch (err) {
    throw new PushSubscriptionError(`invalid push endpoint: ${(err as Error).message}`);
  }
  const p256dh = Buffer.from(sub.keys.p256dh ?? "", "base64url");
  const auth = Buffer.from(sub.keys.auth ?? "", "base64url");
  if (!B64URL.test(sub.keys.p256dh ?? "") || p256dh.length !== 65 || p256dh[0] !== 0x04) throw new PushSubscriptionError("keys.p256dh must be an uncompressed P-256 public key (base64url)");
  if (!B64URL.test(sub.keys.auth ?? "") || auth.length !== 16) throw new PushSubscriptionError("keys.auth must be 16 bytes (base64url)");
  const id = newId("pushSubscription");
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ id, userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, disabledAt: null, failureCount: 0 },
    })
    .returning({ id: pushSubscriptions.id });
  return row?.id ?? id;
}

export class WebPushSender {
  readonly #db: Database;
  readonly #vapid: VapidConfig;
  readonly #http: SafeHttpClient;
  readonly #log: Logger | null;

  constructor(deps: { db: Database; vapid: VapidConfig; http: SafeHttpClient; logger?: Logger }) {
    this.#db = deps.db;
    this.#vapid = deps.vapid;
    this.#http = deps.http;
    this.#log = deps.logger ?? null;
  }

  get publicKey(): string {
    return this.#vapid.publicKey;
  }

  async sendToUser(userId: string, message: PushMessage, opts: { ttlSeconds?: number } = {}): Promise<PushDelivery> {
    const subs = await this.#db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.disabledAt)));
    // ~4 KB max encrypted payload: keep the JSON small.
    const payload = JSON.stringify({
      title: message.title.slice(0, 120),
      body: message.body.slice(0, 1000),
      ...(message.url ? { url: message.url.slice(0, 1000) } : {}),
      ...(message.tag ? { tag: message.tag.slice(0, 64) } : {}),
    });
    let delivered = 0;
    let expired = 0;
    let failed = 0;
    let retryable = false;
    const errors: string[] = [];

    for (const sub of subs) {
      try {
        const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          vapidDetails: { subject: this.#vapid.subject, publicKey: this.#vapid.publicKey, privateKey: this.#vapid.privateKey },
          TTL: opts.ttlSeconds ?? 3600,
          urgency: "high",
          contentEncoding: "aes128gcm",
        });
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(details.headers)) headers[k.toLowerCase()] = String(v);
        const res = await this.#http.request({ url: details.endpoint, method: "POST", headers, ...(details.body ? { body: new Uint8Array(details.body) } : {}) });
        if (res.status >= 200 && res.status < 300) {
          delivered++;
          await this.#db.update(pushSubscriptions).set({ lastSuccessAt: sql`now()`, failureCount: 0 }).where(eq(pushSubscriptions.id, sub.id));
        } else if (res.status === 404 || res.status === 410) {
          // The browser unsubscribed or the subscription expired: never try it again.
          expired++;
          await this.#db.update(pushSubscriptions).set({ disabledAt: sql`now()` }).where(eq(pushSubscriptions.id, sub.id));
        } else {
          failed++;
          if (res.status === 429 || res.status >= 500) retryable = true;
          errors.push(`push service HTTP ${res.status}`);
          await this.#db.update(pushSubscriptions).set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` }).where(eq(pushSubscriptions.id, sub.id));
        }
      } catch (err) {
        failed++;
        if (err instanceof HttpTransportError) retryable = true;
        errors.push(err instanceof SsrfBlockedError || err instanceof HttpTransportError ? err.message : `push error: ${(err as Error).message}`);
        this.#log?.warn({ err, subscription: sub.id }, "web push delivery failed");
      }
    }
    return { subscriptions: subs.length, delivered, expired, failed, retryable, errors: [...new Set(errors)] };
  }
}
