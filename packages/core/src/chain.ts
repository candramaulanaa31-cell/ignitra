import { defineChain, type Chain } from "viem";
import { normalizeAddress, normalizeHash } from "./address";

/**
 * Robinhood Chain configuration.
 *
 * Presets hold the publicly documented endpoints (Robinhood Chain is an
 * Arbitrum Orbit L2 settling to Ethereum, native gas token ETH, Blockscout
 * explorer). Every endpoint can be overridden from env; an unknown chain id
 * (e.g. a local fork) is allowed only when RPC + explorer are given explicitly.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export interface ChainPreset {
  readonly id: number;
  readonly name: string;
  readonly testnet: boolean;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
}

export const CHAIN_PRESETS: Readonly<Record<number, ChainPreset>> = {
  [ROBINHOOD_CHAIN_ID]: {
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    testnet: false,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
  },
  [ROBINHOOD_TESTNET_CHAIN_ID]: {
    id: ROBINHOOD_TESTNET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    testnet: true,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
};

export const NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

export interface ChainConfig {
  readonly id: number;
  readonly name: string;
  readonly testnet: boolean;
  readonly nativeCurrency: typeof NATIVE_CURRENCY;
  readonly rpc: {
    readonly primary: string;
    readonly fallback: string | null;
    readonly ws: string | null;
  };
  readonly explorerUrl: string;
  /** viem chain object for clients. */
  readonly viemChain: Chain;
}

export interface ChainConfigInput {
  chainId: number;
  rpcUrlPrimary?: string | undefined;
  rpcUrlFallback?: string | undefined;
  wsUrl?: string | undefined;
  explorerUrl?: string | undefined;
}

export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigError";
  }
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export function resolveChainConfig(input: ChainConfigInput): ChainConfig {
  const preset = CHAIN_PRESETS[input.chainId];
  const primary = input.rpcUrlPrimary ?? preset?.rpcUrl;
  const explorer = input.explorerUrl ?? preset?.explorerUrl;

  if (!primary || !explorer) {
    throw new ChainConfigError(
      `Chain ${input.chainId} has no preset; RPC_URL_PRIMARY and EXPLORER_URL are required`,
    );
  }

  const name = preset?.name ?? `Custom chain ${input.chainId}`;
  const explorerUrl = stripTrailingSlash(explorer);
  const fallback = input.rpcUrlFallback ?? null;
  const ws = input.wsUrl ?? null;

  const viemChain = defineChain({
    id: input.chainId,
    name,
    nativeCurrency: NATIVE_CURRENCY,
    rpcUrls: {
      default: {
        http: fallback ? [primary, fallback] : [primary],
        ...(ws ? { webSocket: [ws] } : {}),
      },
    },
    blockExplorers: { default: { name: "Explorer", url: explorerUrl } },
    testnet: preset?.testnet ?? true,
  });

  return {
    id: input.chainId,
    name,
    testnet: preset?.testnet ?? true,
    nativeCurrency: NATIVE_CURRENCY,
    rpc: { primary, fallback, ws },
    explorerUrl,
    viemChain,
  };
}

export function explorerTxUrl(chain: Pick<ChainConfig, "explorerUrl">, txHash: string): string {
  return `${chain.explorerUrl}/tx/${normalizeHash(txHash)}`;
}

export function explorerAddressUrl(chain: Pick<ChainConfig, "explorerUrl">, address: string): string {
  return `${chain.explorerUrl}/address/${normalizeAddress(address)}`;
}

export function explorerBlockUrl(chain: Pick<ChainConfig, "explorerUrl">, blockNumber: bigint | number): string {
  return `${chain.explorerUrl}/block/${blockNumber.toString()}`;
}
