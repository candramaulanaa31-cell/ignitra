"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import type { Me } from "@/lib/types";
import { SignInCancelled, discoverWallets, signInWithWallet, type WalletOption } from "@/lib/wallet";
import { Notice, Spinner } from "./ui";

interface SessionValue {
  readonly me: Me;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside <SessionGate>");
  return s;
}

/** Loads /v1/me; signed out → the wallet sign-in screen instead of the page. */
export function SessionGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe((await api<{ data: Me }>("/v1/me")).data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api("/v1/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  }, []);

  if (error && me === undefined) {
    return (
      <div className="stack" style={{ maxWidth: 520, margin: "40px auto" }}>
        <Notice kind="error">IGNITRA is unreachable: {error}</Notice>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }
  if (me === undefined) return <Spinner />;
  if (me === null) return <SignIn onSignedIn={setMe} />;
  return <SessionContext.Provider value={{ me, refresh, signOut }}>{children}</SessionContext.Provider>;
}

function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void discoverWallets().then(setWallets);
  }, []);

  const go = async (w: WalletOption) => {
    setBusy(w.id);
    setError(null);
    try {
      onSignedIn(await signInWithWallet(w.provider));
    } catch (err) {
      setError(err instanceof SignInCancelled ? "Cancelled in the wallet." : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="card-head">
        <span className="label">Sign in</span>
      </div>
      <div className="card-body stack">
        <p>
          Sign in with your wallet. You sign a message (<span className="mono">Sign-In with Ethereum</span>): it is not a transaction, costs no gas, and your keys never leave the wallet.
        </p>
        {wallets === null ? <Spinner label="Looking for wallets…" /> : null}
        {wallets?.length === 0 ? (
          <Notice kind="warn">
            No wallet found in this browser. Install MetaMask, Rabby or Coinbase Wallet, or open IGNITRA in your wallet app&apos;s browser.
          </Notice>
        ) : null}
        <div className="stack" style={{ gap: 8 }}>
          {wallets?.map((w) => (
            <button key={w.id} type="button" className="btn" disabled={busy !== null} onClick={() => void go(w)} style={{ justifyContent: "flex-start" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : null}
              {busy === w.id ? "Check your wallet…" : `Continue with ${w.name}`}
            </button>
          ))}
        </div>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <p className="small faint">Robinhood Chain (4663). New wallets start on the Free plan: 3 active flows, 500 runs a month.</p>
      </div>
    </div>
  );
}
