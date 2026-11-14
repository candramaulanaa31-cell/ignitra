import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { CopyButton } from "@/components/ui";
import { SOURCE_URL, TOKEN, TOKEN_LAUNCH, X_HANDLE, X_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "$IGNITRA",
  description: "The community token around IGNITRA, onchain automation for Robinhood Chain: the only official address, how to check it, and what it is not.",
};

/** $IGNITRA: the official address (TOKEN_ADDRESS) or, before the launch, when it comes (TOKEN_LAUNCH). */
export default function TokenPage() {
  const token = TOKEN;
  const prefill = token ? `?token=${token.address.toLowerCase()}` : "";
  const status = token ? "Live on Pons" : TOKEN_LAUNCH ? `Launches ${TOKEN_LAUNCH}` : "Not launched";
  const xLink = (
    <a href={X_URL} target="_blank" rel="noreferrer">
      @{X_HANDLE}
    </a>
  );
  return (
    <div className="wrap">
      <SiteHeader />
      <main className="stack token-page">
        <div>
          <p className="eyebrow">Community token · Robinhood Chain</p>
          <h1>$IGNITRA</h1>
          <p className="lede" style={{ marginTop: 8 }}>
            The community token around IGNITRA, onchain automation for Robinhood Chain. {token ? "Launched on Pons." : "Launching on Pons."}
          </p>
        </div>

        <section className="card" aria-labelledby="official">
          <div className="card-head">
            <span className="label" id="official">
              The only official address
            </span>
            <span className={`badge plain ${token ? "s-live" : "s-partial"}`}>{status}</span>
          </div>
          <div className="card-body stack">
            {token ? (
              <>
                <code className="token-address">{token.address}</code>
                <div className="row">
                  <CopyButton value={token.address} text="Copy address" />
                  {token.tradeUrl ? (
                    <a className="btn sm primary" href={token.tradeUrl} target="_blank" rel="noreferrer">
                      Trade on Pons
                    </a>
                  ) : null}
                  <a className="btn sm" href={token.explorerUrl} target="_blank" rel="noreferrer">
                    View on the explorer
                  </a>
                </div>
                <p className="small muted">
                  This page and {xLink} are the only places it is posted. Compare every character before you buy: a token with the same name and logo takes a minute to make.
                </p>
              </>
            ) : (
              <p>
                Not launched yet{TOKEN_LAUNCH ? `: planned for ${TOKEN_LAUNCH}, on Pons` : ""}. Anything called $IGNITRA before then is not ours. The address will appear here and on {xLink}, nowhere else.
              </p>
            )}
          </div>
        </section>

        <div className="grid2">
          <section className="card" aria-labelledby="what-it-is">
            <div className="card-head">
              <span className="label" id="what-it-is">
                What it is
              </span>
            </div>
            <div className="card-body">
              <ul className="token-list">
                <li>The community token around IGNITRA and the people who use it.</li>
                <li>An ERC-20 on Robinhood Chain, {token ? "launched" : "launching"} on Pons: it trades on a bonding curve until it graduates to a pool.</li>
                <li>
                  Made by a project whose code is public:{" "}
                  <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                    the source on GitHub
                  </a>
                  .
                </li>
              </ul>
            </div>
          </section>
          <section className="card" aria-labelledby="what-it-is-not">
            <div className="card-head">
              <span className="label" id="what-it-is-not">
                What it is not
              </span>
            </div>
            <div className="card-body">
              <ul className="token-list">
                <li>Not a share of IGNITRA: no ownership, revenue, dividends or votes.</li>
                <li>Not a key to the product: IGNITRA is free to start whether you hold it or not.</li>
                <li>Not a promise: nobody can tell you its price, and nobody should.</li>
                <li>Not affiliated with Robinhood.</li>
              </ul>
            </div>
          </section>
        </div>

        <section className="card" aria-labelledby="follow">
          <div className="card-head">
            <span className="label" id="follow">
              Follow $IGNITRA with IGNITRA
            </span>
          </div>
          <div className="card-body stack">
            <p className="muted">The product this token belongs to watches any token on Robinhood Chain. Point it at $IGNITRA in two minutes, free:</p>
            <div className="row">
              {token ? (
                <>
                  <Link className="btn sm" href={`/app/templates/big-buy-telegram${prefill}`}>
                    Big buys → Telegram
                  </Link>
                  <Link className="btn sm" href={`/app/templates/new-holder-welcome-telegram${prefill}`}>
                    New holders → Telegram
                  </Link>
                </>
              ) : null}
              <Link className="btn sm" href="/templates/pons-launch-telegram">
                Every new Pons launch → Telegram
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
