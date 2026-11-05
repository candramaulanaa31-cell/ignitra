import { describe, expect, it } from "vitest";
import {
  ChainConfigError,
  ROBINHOOD_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  resolveChainConfig,
} from "./chain";
import { redactUrl } from "./url";

describe("resolveChainConfig", () => {
  it("uses Robinhood Chain presets by default", () => {
    const chain = resolveChainConfig({ chainId: ROBINHOOD_CHAIN_ID });
    expect(chain.id).toBe(4663);
    expect(chain.name).toBe("Robinhood Chain");
    expect(chain.testnet).toBe(false);
    expect(chain.rpc).toEqual({ primary: "https://rpc.mainnet.chain.robinhood.com", fallback: null, ws: null });
    expect(chain.viemChain.id).toBe(4663);
    expect(chain.nativeCurrency.symbol).toBe("ETH");
  });

  it("lets env override endpoints and includes the fallback in the viem chain", () => {
    const chain = resolveChainConfig({
      chainId: ROBINHOOD_CHAIN_ID,
      rpcUrlPrimary: "https://primary.example",
      rpcUrlFallback: "https://fallback.example",
      wsUrl: "wss://ws.example",
      explorerUrl: "https://explorer.example/",
    });
    expect(chain.viemChain.rpcUrls.default.http).toEqual(["https://primary.example", "https://fallback.example"]);
    expect(chain.viemChain.rpcUrls.default.webSocket).toEqual(["wss://ws.example"]);
    expect(chain.explorerUrl).toBe("https://explorer.example");
  });

  it("requires explicit endpoints for unknown chains (e.g. a local fork)", () => {
    expect(() => resolveChainConfig({ chainId: 31337 })).toThrow(ChainConfigError);
    const fork = resolveChainConfig({ chainId: 31337, rpcUrlPrimary: "http://127.0.0.1:8545", explorerUrl: "http://localhost" });
    expect(fork.name).toBe("Custom chain 31337");
  });

  it("builds explorer links from normalized values", () => {
    const chain = resolveChainConfig({ chainId: ROBINHOOD_CHAIN_ID });
    const hash = `0x${"AB".repeat(32)}`;
    expect(explorerTxUrl(chain, hash)).toBe(`https://robinhoodchain.blockscout.com/tx/0x${"ab".repeat(32)}`);
    expect(explorerAddressUrl(chain, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(
      "https://robinhoodchain.blockscout.com/address/0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    );
  });
});

describe("redactUrl", () => {
  it("hides paths, query strings and credentials that may hold API keys", () => {
    expect(redactUrl("https://rpc.example/v2/SECRETKEY")).toBe("https://rpc.example/***");
    expect(redactUrl("https://rpc.example/?key=SECRET")).toBe("https://rpc.example/***");
    expect(redactUrl("https://user:pass@rpc.example")).toBe("https://rpc.example/***");
    expect(redactUrl("https://rpc.mainnet.chain.robinhood.com")).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });
});
