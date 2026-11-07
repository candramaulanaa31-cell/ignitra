"use client";

import { getAddress, toHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { CHAIN_PRESETS, NATIVE_CURRENCY, ROBINHOOD_CHAIN_ID } from "@ignitra/core";
import { api } from "./api";
import type { Me } from "./types";

/**
 * Wallet sign-in. Any injected wallet (EIP-6963 discovery: MetaMask, Rabby,
 * Coinbase Wallet, OKX, …, or window.ethereum). The wallet signs a
 * Sign-In with Ethereum message: no transaction, no gas, no key leaves it.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletOption {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly provider: Eip1193Provider;
}

interface AnnounceDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** Wallets announced within `waitMs` (EIP-6963), plus the legacy injected one. */
export function discoverWallets(waitMs = 300): Promise<WalletOption[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletOption>();
    const onAnnounce = (event: Event) => {
      const d = (event as CustomEvent<AnnounceDetail>).detail;
      if (d?.info?.rdns && d.provider) found.set(d.info.rdns, { id: d.info.rdns, name: d.info.name, icon: d.info.icon || null, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (found.size === 0 && legacy) found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: legacy });
      resolve([...found.values()]);
    }, waitMs);
  });
}

const CHAIN_HEX = toHex(ROBINHOOD_CHAIN_ID);

/** Best effort: ask the wallet to use Robinhood Chain (adding it when unknown). Signing works either way. */
async function useRobinhoodChain(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) return;
    const preset = CHAIN_PRESETS[ROBINHOOD_CHAIN_ID];
    if (!preset) return;
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: CHAIN_HEX, chainName: preset.name, nativeCurrency: NATIVE_CURRENCY, rpcUrls: [preset.rpcUrl], blockExplorerUrls: [preset.explorerUrl] }],
      });
    } catch {
      // the user declined: fine, signing does not need it
    }
  }
}

export class SignInCancelled extends Error {
  constructor() {
    super("signature request was cancelled in the wallet");
    this.name = "SignInCancelled";
  }
}

export async function signInWithWallet(provider: Eip1193Provider): Promise<Me> {
  let accounts: string[];
  try {
    accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  } catch (err) {
    if ((err as { code?: number }).code === 4001) throw new SignInCancelled();
    throw err;
  }
  const account = accounts[0];
  if (!account) throw new Error("the wallet returned no account");
  await useRobinhoodChain(provider);
  const { nonce } = await api<{ nonce: string }>("/v1/auth/nonce");
  const address = getAddress(account);
  const message = createSiweMessage({
    address,
    chainId: ROBINHOOD_CHAIN_ID,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: "1",
    issuedAt: new Date(),
    statement: "Sign in to IGNITRA. This is not a transaction and costs no gas.",
  });
  let signature: string;
  try {
    signature = (await provider.request({ method: "personal_sign", params: [toHex(message), address] })) as string;
  } catch (err) {
    if ((err as { code?: number }).code === 4001) throw new SignInCancelled();
    throw err;
  }
  await api("/v1/auth/verify", { body: { message, signature } });
  return (await api<{ data: Me }>("/v1/me")).data;
}
