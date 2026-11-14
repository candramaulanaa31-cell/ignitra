import { describe, expect, it } from "vitest";
import { launchNoteFromEnv, shortAddress, tokenFromEnv } from "./site";

describe("the launch note", () => {
  it("takes short plain text and nothing else", () => {
    expect(launchNoteFromEnv("Monday, Nov 16")).toBe("Monday, Nov 16");
    expect(launchNoteFromEnv("  Mon 16/11 20:00  ")).toBe("Mon 16/11 20:00");
    expect(launchNoteFromEnv(undefined)).toBeNull();
    expect(launchNoteFromEnv("")).toBeNull();
    expect(launchNoteFromEnv("<script>alert(1)</script>")).toBeNull();
    expect(launchNoteFromEnv("x".repeat(41))).toBeNull();
  });

  it("shortens an address to its ends", () => {
    expect(shortAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toBe("0x5fc5…d168");
  });
});

describe("the community token setting", () => {
  it("is off until a valid address is set", () => {
    expect(tokenFromEnv(undefined, undefined)).toBeNull();
    expect(tokenFromEnv("", "https://example.com")).toBeNull();
    expect(tokenFromEnv("0x123", undefined)).toBeNull();
    expect(tokenFromEnv("not an address", undefined)).toBeNull();
  });

  it("shows the address checksummed and links the explorer by the lowercase one", () => {
    const token = tokenFromEnv("  0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168 ", undefined);
    expect(token?.address).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(token?.explorerUrl).toBe("https://robinhoodchain.blockscout.com/token/0x5fc5360d0400a0fd4f2af552add042d716f1d168");
    expect(token?.tradeUrl).toBeNull();
  });

  it("keeps the trade link only when it is an https URL", () => {
    const address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    expect(tokenFromEnv(address, "https://launchpad.example/token/1")?.tradeUrl).toBe("https://launchpad.example/token/1");
    expect(tokenFromEnv(address, "javascript:alert(1)")?.tradeUrl).toBeNull();
    expect(tokenFromEnv(address, "http://plain.example")?.tradeUrl).toBeNull();
  });
});
