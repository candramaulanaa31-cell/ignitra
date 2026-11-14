import { getAddress } from "viem";

/**
 * The site's public origin, for absolute URLs: share cards, the sitemap, links in shared templates.
 * WEB_URL is the same setting the API uses for links back to the web app; on Vercel the project's
 * production domain is the fallback, then localhost for development.
 */
export const SITE_URL = (
  process.env.WEB_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")
).replace(/\/+$/, "");

/** The source code (AGPL-3.0): linked from the site so every user can get it. */
export const SOURCE_URL = "https://github.com/candramaulanaa31-cell/ignitra";

/** IGNITRA on X. */
export const X_HANDLE = "ignitra_run";
export const X_URL = `https://x.com/${X_HANDLE}`;

export interface CommunityToken {
  symbol: string;
  /** Checksummed (EIP-55), the way people compare addresses. */
  address: string;
  explorerUrl: string;
  /** Its page on the launchpad, if one was set. */
  tradeUrl: string | null;
}

/** Reads the community token from the environment; anything malformed means no token. */
export function tokenFromEnv(address: string | undefined, tradeUrl: string | undefined): CommunityToken | null {
  const value = address?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const lower = value.toLowerCase() as `0x${string}`;
  const trade = tradeUrl?.trim() ?? "";
  return {
    symbol: "IGNITRA",
    address: getAddress(lower),
    explorerUrl: `https://robinhoodchain.blockscout.com/token/${lower}`,
    tradeUrl: /^https:\/\/\S+$/.test(trade) ? trade : null,
  };
}

/**
 * The community token, in the landing page's footer once TOKEN_ADDRESS is set (a Vercel environment
 * variable: deploy again after setting it). TOKEN_TRADE_URL, optional, is its launchpad page.
 */
export const TOKEN = tokenFromEnv(process.env.TOKEN_ADDRESS, process.env.TOKEN_TRADE_URL);

/** When the token launches, the way people should read it ("Monday, Nov 16"); plain text only. */
export function launchNoteFromEnv(value: string | undefined): string | null {
  const note = value?.trim() ?? "";
  return note.length > 0 && note.length <= 40 && /^[\w ,.:/-]+$/.test(note) ? note : null;
}

/**
 * Before the token exists (TOKEN_LAUNCH set, TOKEN_ADDRESS not yet): the announcement bar and /token
 * say when it launches and that anything with its name before then is not ours.
 */
export const TOKEN_LAUNCH = launchNoteFromEnv(process.env.TOKEN_LAUNCH);

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The docs pages, in reading order: the docs navigation and the sitemap. */
export const DOC_PAGES = [
  ["/docs", "Overview"],
  ["/docs/triggers", "Triggers"],
  ["/docs/conditions", "Conditions"],
  ["/docs/actions", "Actions"],
  ["/docs/variables", "Variables"],
  ["/docs/webhooks", "Webhooks"],
  ["/docs/integrations", "Integrations"],
  ["/docs/onchain", "Onchain"],
  ["/docs/api", "API"],
  ["/docs/sdk", "SDK"],
] as const;
