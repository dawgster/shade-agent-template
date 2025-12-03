import { describe, expect, it } from "vitest";
import { extractSolanaMintAddress, SOL_NATIVE_MINT } from "./constants";

describe("constants", () => {
  describe("SOL_NATIVE_MINT", () => {
    it("has the correct native SOL mint address", () => {
      expect(SOL_NATIVE_MINT).toBe("So11111111111111111111111111111111111111112");
    });
  });

  describe("extractSolanaMintAddress", () => {
    describe("1cs_v1 format", () => {
      it("extracts mint address from 1cs_v1:sol:spl:<mintAddress> format", () => {
        const assetId = "1cs_v1:sol:spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        expect(extractSolanaMintAddress(assetId)).toBe(
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
      });

      it("extracts mint address from 1cs_v1:sol:spl:<mintAddress>:<decimals> format", () => {
        const assetId = "1cs_v1:sol:spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:6";
        expect(extractSolanaMintAddress(assetId)).toBe(
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
      });

      it("handles native SOL mint in 1cs_v1 format", () => {
        const assetId = "1cs_v1:sol:spl:So11111111111111111111111111111111111111112:9";
        expect(extractSolanaMintAddress(assetId)).toBe(SOL_NATIVE_MINT);
      });

      it("returns original if 1cs_v1 format is incomplete", () => {
        const assetId = "1cs_v1:sol:spl:";
        expect(extractSolanaMintAddress(assetId)).toBe(assetId);
      });
    });

    describe("sol: prefix format", () => {
      it("extracts mint address from sol:<mintAddress> format", () => {
        const assetId = "sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        expect(extractSolanaMintAddress(assetId)).toBe(
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
      });

      it("handles native SOL mint in sol: format", () => {
        const assetId = "sol:So11111111111111111111111111111111111111112";
        expect(extractSolanaMintAddress(assetId)).toBe(SOL_NATIVE_MINT);
      });
    });

    describe("raw mint address format", () => {
      it("returns raw mint address unchanged (USDC)", () => {
        const mintAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        expect(extractSolanaMintAddress(mintAddress)).toBe(mintAddress);
      });

      it("returns native SOL mint unchanged", () => {
        expect(extractSolanaMintAddress(SOL_NATIVE_MINT)).toBe(SOL_NATIVE_MINT);
      });

      it("handles short valid base58 address (32 chars)", () => {
        const shortAddress = "11111111111111111111111111111111";
        expect(extractSolanaMintAddress(shortAddress)).toBe(shortAddress);
      });

      it("handles typical 44-char base58 address", () => {
        const address = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
        expect(extractSolanaMintAddress(address)).toBe(address);
      });
    });

    describe("unrecognized formats", () => {
      it("returns original for unrecognized format", () => {
        const unknownFormat = "nep141:wrap.near";
        expect(extractSolanaMintAddress(unknownFormat)).toBe(unknownFormat);
      });

      it("returns original for empty string", () => {
        expect(extractSolanaMintAddress("")).toBe("");
      });

      it("returns original for ethereum-style address", () => {
        const ethAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
        expect(extractSolanaMintAddress(ethAddress)).toBe(ethAddress);
      });

      it("returns original for arbitrary string", () => {
        const arbitrary = "some-random-string";
        expect(extractSolanaMintAddress(arbitrary)).toBe(arbitrary);
      });

      it("returns original for string with invalid base58 characters", () => {
        // Base58 excludes 0, O, I, l
        const invalidBase58 = "0OIl111111111111111111111111111111";
        expect(extractSolanaMintAddress(invalidBase58)).toBe(invalidBase58);
      });
    });

    describe("edge cases", () => {
      it("handles undefined by returning undefined", () => {
        // @ts-expect-error testing undefined input
        expect(extractSolanaMintAddress(undefined)).toBe(undefined);
      });

      it("handles null by returning null", () => {
        // @ts-expect-error testing null input
        expect(extractSolanaMintAddress(null)).toBe(null);
      });

      it("handles colons in mint address correctly for 1cs_v1 format", () => {
        // Even if there are extra parts, it should get the 4th element (index 3)
        const assetId = "1cs_v1:sol:spl:MintAddr:6:extra:parts";
        expect(extractSolanaMintAddress(assetId)).toBe("MintAddr");
      });
    });
  });
});
