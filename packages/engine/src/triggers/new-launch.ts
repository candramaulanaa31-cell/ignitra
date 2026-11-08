import { z } from "zod";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { CHAIN_EVIDENCE_FIELDS, LOG_EVIDENCE_FIELDS, normalizeAddress, type FieldSpec, type NormalizedAddress, type NormalizedHash } from "@ignitra/core";
import { logEvidence, logKey } from "../evidence";
import { addressParam } from "../params";
import type { LogTriggerModule, Payload, TriggerOutcome } from "../types";
import { TRUST_ROLES, trustFields } from "../enrich/trust";
import { amountFields, amountPayload, tokenFields, tokenPayload } from "./erc20";

/**
 * NEW_LAUNCH — a token launched on a known Robinhood Chain launchpad.
 *
 * Pons (verified 2026-10-12 against Sourcify exact-match sources and live logs):
 *   PonsV2LaunchFactory 0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e emits
 *   TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
 *                 address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
 *   for every launch (about two a minute). The V1 factory no longer launches tokens.
 *
 * The payload adds the token's metadata and, best effort, the socials the launcher set
 * (`socials()` on PonsV2LauncherToken: twitter, telegram, discord, website, farcaster).
 * They are chosen by whoever launched the token: show them, never trust them.
 */

export const LAUNCHPADS = {
  pons: {
    label: "Pons",
    factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e" as NormalizedAddress,
    event: "TokenLaunched(address,address,address,address,uint256,uint256)",
  },
} as const;

export type Launchpad = keyof typeof LAUNCHPADS;

export const TOKEN_LAUNCHED_TOPIC = keccak256(toHex(LAUNCHPADS.pons.event)) as NormalizedHash;

export const newLaunchParams = z
  .object({
    launchpad: z.enum(["pons"]).default("pons"),
    /** Only launches by this wallet. */
    deployer: addressParam.optional(),
  })
  .strict();
export type NewLaunchParams = z.output<typeof newLaunchParams>;

const SOCIALS_ABI = parseAbi(["function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)"]);
const SOCIAL_KEYS = ["twitter", "telegram", "discord", "website", "farcaster"] as const;

const FIELDS: readonly FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  ...LOG_EVIDENCE_FIELDS,
  { path: "launchpad", type: "string", description: "The launchpad, e.g. pons" },
  ...tokenFields(),
  { path: "deployer", type: "address", description: "The wallet that launched the token" },
  { path: "curve", type: "address", description: "The token's bonding curve" },
  { path: "pair_token", type: "address", description: "What the curve trades against (0x000… = native ETH)" },
  { path: "pair_symbol", type: "string", description: "ETH, or the pair token symbol", nullable: true },
  { path: "launch_config_id", type: "uint", description: "The launchpad's launch configuration id" },
  ...amountFields("graduation_threshold", "Raise at which the token graduates to a pool"),
  ...SOCIAL_KEYS.map((k): FieldSpec => ({ path: `socials.${k}`, type: "string", description: `${k} link set by the launcher (unverified)`, nullable: true })),
  { path: "counterparty", type: "address", description: "The deployer (for TRUST LAYER scores)" },
  ...trustFields(TRUST_ROLES.NEW_LAUNCH ?? []),
];

const topicAddress = (topic: NormalizedHash | undefined): NormalizedAddress | null => (topic && topic.length === 66 ? normalizeAddress(`0x${topic.slice(26)}`) : null);

export interface ParsedLaunch {
  token: NormalizedAddress;
  curve: NormalizedAddress;
  deployer: NormalizedAddress;
  pairToken: NormalizedAddress;
  launchConfigId: bigint;
  graduationThreshold: bigint;
}

export function parseTokenLaunched(event: { topics: readonly NormalizedHash[]; data: `0x${string}` }): ParsedLaunch | null {
  if (event.topics[0] !== TOKEN_LAUNCHED_TOPIC || event.topics.length !== 4) return null;
  const token = topicAddress(event.topics[1]);
  const curve = topicAddress(event.topics[2]);
  const deployer = topicAddress(event.topics[3]);
  if (!token || !curve || !deployer) return null;
  try {
    const [pairToken, launchConfigId, graduationThreshold] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], event.data);
    return { token, curve, deployer, pairToken: normalizeAddress(pairToken), launchConfigId, graduationThreshold };
  } catch {
    return null;
  }
}

export const newLaunchTrigger: LogTriggerModule<NewLaunchParams> = {
  type: "NEW_LAUNCH",
  kind: "log",
  label: "New token launch",
  description: "A token launched on a Robinhood Chain launchpad (Pons), optionally by one deployer.",
  source: "chain",
  supportsFast: true,
  paramsSchema: newLaunchParams,
  fields: () => FIELDS,
  watches: (p) => [{ address: LAUNCHPADS[p.launchpad].factory, topic0: TOKEN_LAUNCHED_TOPIC }],

  async matchBatch(events, p, rt) {
    const out: Array<TriggerOutcome | null> = [];
    for (const event of events) {
      const launch = event.address === LAUNCHPADS[p.launchpad].factory ? parseTokenLaunched(event) : null;
      if (!launch || (p.deployer && launch.deployer !== p.deployer)) {
        out.push(null);
        continue;
      }
      // Pons quotes most curves in native ETH: the pair token is then the zero address.
      const isNative = /^0x0{40}$/.test(launch.pairToken);
      const [meta, supply, pairMeta, socials] = await Promise.all([
        rt.tokens.meta(launch.token),
        rt.tokens.totalSupply(launch.token),
        isNative ? Promise.resolve(null) : rt.tokens.meta(launch.pairToken).catch(() => null),
        readSocials(rt.reader.call.bind(rt.reader), launch.token),
      ]);
      const payload: Payload = {
        ...logEvidence(event, rt.chain),
        launchpad: p.launchpad,
        token: tokenPayload(meta, supply),
        deployer: launch.deployer,
        counterparty: launch.deployer,
        curve: launch.curve,
        pair_token: launch.pairToken,
        pair_symbol: isNative ? "ETH" : (pairMeta?.symbol ?? null),
        launch_config_id: launch.launchConfigId.toString(),
        ...amountPayload("graduation_threshold", launch.graduationThreshold, isNative ? 18 : (pairMeta?.decimals ?? null)),
        socials,
      };
      out.push({ kind: "match", key: logKey(event), chainEventId: event.id, payload });
    }
    return out;
  },
};

/** Socials as the launcher set them: empty values become null; any failure leaves them all null. */
export async function readSocials(call: (req: { to: NormalizedAddress; data: `0x${string}` }) => Promise<`0x${string}`>, token: NormalizedAddress): Promise<Record<(typeof SOCIAL_KEYS)[number], string | null>> {
  const empty = Object.fromEntries(SOCIAL_KEYS.map((k) => [k, null])) as Record<(typeof SOCIAL_KEYS)[number], string | null>;
  try {
    const raw = await call({ to: token, data: encodeFunctionData({ abi: SOCIALS_ABI, functionName: "socials" }) });
    const values = decodeFunctionResult({ abi: SOCIALS_ABI, functionName: "socials", data: raw });
    const out = { ...empty };
    SOCIAL_KEYS.forEach((k, i) => {
      const v = String(values[i] ?? "").trim().slice(0, 300);
      out[k] = v === "" ? null : v;
    });
    return out;
  } catch {
    return empty;
  }
}
