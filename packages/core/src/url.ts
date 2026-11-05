/**
 * RPC providers embed API keys in the URL path or query. Never log a full
 * endpoint URL — log this instead.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hasPath = url.pathname !== "/" && url.pathname !== "";
    const hasSecrets = hasPath || url.search !== "" || url.username !== "" || url.password !== "";
    return `${url.protocol}//${url.host}${hasSecrets ? "/***" : ""}`;
  } catch {
    return "<invalid url>";
  }
}
