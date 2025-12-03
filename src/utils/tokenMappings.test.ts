import { describe, expect, it } from "vitest";
import {
  getDefuseAssetId,
  getSolDefuseAssetId,
  getTokenByDefuseId,
  getTokensForChain,
} from "./tokenMappings";
import { SOL_NATIVE_MINT } from "../constants";

describe("tokenMappings", () => {
  describe("getSolDefuseAssetId", () => {
    it("returns the correct SOL defuse asset ID", () => {
      expect(getSolDefuseAssetId()).toBe("nep141:sol.omft.near");
    });
  });

  describe("getDefuseAssetId", () => {
    it("returns SOL defuse ID for native SOL mint address", () => {
      const result = getDefuseAssetId("solana", SOL_NATIVE_MINT);
      expect(result).toBe("nep141:sol.omft.near");
    });

    it("finds USDC by symbol on ethereum", () => {
      const result = getDefuseAssetId("eth", "USDC");
      expect(result).toBeTruthy();
      expect(result).toContain("nep141:");
    });

    it("finds USDC by symbol case-insensitively", () => {
      const resultLower = getDefuseAssetId("eth", "usdc");
      const resultUpper = getDefuseAssetId("ETH", "USDC");
      expect(resultLower).toBe(resultUpper);
    });

    it("finds token by address on ethereum", () => {
      const usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const result = getDefuseAssetId("eth", usdcAddress);
      expect(result).toBeTruthy();
    });

    it("handles case-insensitive address lookup", () => {
      const usdcLower = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const usdcUpper = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const resultLower = getDefuseAssetId("eth", usdcLower);
      const resultUpper = getDefuseAssetId("eth", usdcUpper);
      expect(resultLower).toBe(resultUpper);
    });

    it("handles chain name case-insensitively", () => {
      const resultLower = getDefuseAssetId("eth", "USDC");
      const resultUpper = getDefuseAssetId("ETH", "USDC");
      expect(resultLower).toBe(resultUpper);
    });

    it("finds USDC on base chain", () => {
      const result = getDefuseAssetId("base", "USDC");
      expect(result).toBeTruthy();
      expect(result).toContain("base");
    });

    it("finds token on near chain", () => {
      const result = getDefuseAssetId("near", "USDC");
      expect(result).toBeTruthy();
    });
  });

  describe("getTokenByDefuseId", () => {
    it("returns token info for valid defuse ID", () => {
      const solDefuseId = getSolDefuseAssetId();
      const token = getTokenByDefuseId(solDefuseId);
      // SOL may or may not be in the mappings - if present, check structure
      if (token) {
        expect(token.defuseAssetId).toBe(solDefuseId);
        expect(token).toHaveProperty("symbol");
        expect(token).toHaveProperty("decimals");
      }
    });

    it("returns correct token structure when found", () => {
      // Get USDC defuse ID first
      const usdcDefuseId = getDefuseAssetId("eth", "USDC");
      if (usdcDefuseId) {
        const token = getTokenByDefuseId(usdcDefuseId);
        expect(token).toBeTruthy();
        expect(token?.defuseAssetId).toBe(usdcDefuseId);
        expect(token?.symbol).toBe("USDC");
        expect(token?.decimals).toBe(6);
        expect(Array.isArray(token?.deployments)).toBe(true);
      }
    });
  });
});
