import "server-only";

/**
 * Server-side reads of PUBLIC API endpoints (gallery, docs catalogs, demo) for
 * server-rendered pages. Never forwards cookies.
 */
const API_URL = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** The API could not answer: network error, timeout or a 5xx (not a 404). */
export class ApiUnavailableError extends Error {
  constructor(path: string, detail: string) {
    super(`API unavailable for ${path}: ${detail}`);
    this.name = "ApiUnavailableError";
  }
}

async function get<T>(path: string, revalidateSeconds: number): Promise<T | null> {
  let res: Response;
  try {
    // Only 200 responses enter Next's data cache, so a failure is retried on the next render.
    res = await fetch(`${API_URL}${path}`, { next: { revalidate: revalidateSeconds }, signal: AbortSignal.timeout(4000) });
  } catch (err) {
    throw new ApiUnavailableError(path, (err as Error).message);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiUnavailableError(path, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Best effort: null when the API is down or says 404. For pages that must always render and refresh often (landing). */
export async function serverGet<T>(path: string, revalidateSeconds = 60): Promise<T | null> {
  try {
    return await get<T>(path, revalidateSeconds);
  } catch {
    return null;
  }
}

/**
 * For cached (ISR) pages: null only when the API says 404. When the API is
 * unavailable it throws, so Next keeps serving the last good version instead of
 * caching a fallback or a 404 for the whole revalidate period. During `next build`
 * it returns null instead: pages pre-render with their fallbacks and refresh later.
 */
export async function serverGetCached<T>(path: string, revalidateSeconds = 60): Promise<T | null> {
  try {
    return await get<T>(path, revalidateSeconds);
  } catch (err) {
    if (BUILDING && err instanceof ApiUnavailableError) return null;
    throw err;
  }
}
