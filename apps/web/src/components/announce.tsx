import Link from "next/link";
import { TOKEN, TOKEN_LAUNCH, shortAddress } from "@/lib/site";

/**
 * One line above the public pages' header around the community token's launch: before it, when it
 * launches and that anything with its name is not ours yet; after it, the official address.
 */
export function Announcement() {
  if (TOKEN) {
    return (
      <div className="announce">
        <span>
          <strong>${TOKEN.symbol} is live.</strong> Official address <code>{shortAddress(TOKEN.address)}</code>
        </span>
        <Link href="/token">Check it →</Link>
      </div>
    );
  }
  if (TOKEN_LAUNCH) {
    return (
      <div className="announce">
        <span>
          <strong>$IGNITRA launches {TOKEN_LAUNCH} on Pons.</strong> Anything called $IGNITRA before then is not ours.
        </span>
        <Link href="/token">Where the address will be →</Link>
      </div>
    );
  }
  return null;
}
