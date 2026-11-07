"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "./types";

/**
 * The browser calls the API through this app's /api proxy (same origin), so
 * the HttpOnly session cookie travels automatically and CSRF checks see our Origin.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Issue[];
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = Array.isArray(details.issues) ? (details.issues as Issue[]) : [];
    this.details = details;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: "same-origin",
      cache: "no-store",
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "cannot reach IGNITRA; check your connection");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (proxy error page)
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, e ?? {});
  }
  return json as T;
}

/** Message for a failed call; validation issues are listed. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.issues.length ? `${err.message}: ${err.issues.map((i) => `${i.path || "flow"}: ${i.message}`).join("; ")}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (data: T) => void;
}

/** Tiny fetch-on-mount hook. `path: null` waits. `pollMs` re-fetches while `poll(data)` holds. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; poll?: (data: T) => boolean } = {}): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const pollRef = useRef(opts.poll);
  pollRef.current = opts.poll;

  const load = useCallback(async () => {
    if (path === null) return;
    try {
      const next = await api<T>(path);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(path !== null);
    void load();
  }, [load, path]);

  useEffect(() => {
    if (!opts.pollMs || data === undefined) return;
    if (pollRef.current && !pollRef.current(data)) return;
    const t = setTimeout(() => void load(), opts.pollMs);
    return () => clearTimeout(t);
  }, [data, load, opts.pollMs]);

  return { data, error, loading, reload: load, setData };
}
