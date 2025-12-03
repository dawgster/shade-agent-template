import { describe, expect, it } from "vitest";
import { validateIntent } from "./validation";
import { IntentMessage, KaminoDepositMetadata, KaminoWithdrawMetadata } from "./types";

const baseIntent: IntentMessage = {
  intentId: "test-intent",
  sourceChain: "solana",
  destinationChain: "solana",
  sourceAsset: "So11111111111111111111111111111111111111111",
  finalAsset: "So11111111111111111111111111111111111111111",
  sourceAmount: "1000000",
  destinationAmount: "1000000",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
};

describe("validateIntent", () => {
  describe("basic validation", () => {
    it("fills default slippage when omitted", () => {
      const validated = validateIntent(baseIntent);
      expect(validated.slippageBps).toBe(300);
    });

    it("fills default intermediate asset when omitted", () => {
      const validated = validateIntent(baseIntent);
      expect(validated.intermediateAsset).toBe(
        "So11111111111111111111111111111111111111112",
      );
    });

    it("preserves provided slippage", () => {
      const validated = validateIntent({ ...baseIntent, slippageBps: 50 });
      expect(validated.slippageBps).toBe(50);
    });

    it("preserves provided intermediate asset", () => {
      const validated = validateIntent({
        ...baseIntent,
        intermediateAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });
      expect(validated.intermediateAsset).toBe(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
    });
  });

  describe("required field validation", () => {
    it("rejects missing intentId", () => {
      expect(() =>
        validateIntent({ ...baseIntent, intentId: "" }),
      ).toThrow(/intentId/);
    });

    it("rejects missing userDestination", () => {
      expect(() =>
        validateIntent({ ...baseIntent, userDestination: "" }),
      ).toThrow(/userDestination/);
    });

    it("rejects missing agentDestination", () => {
      expect(() =>
        validateIntent({ ...baseIntent, agentDestination: "" }),
      ).toThrow(/agentDestination/);
    });

    it("rejects missing sourceAsset", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAsset: "" }),
      ).toThrow(/sourceAsset/);
    });

    it("rejects missing finalAsset", () => {
      expect(() =>
        validateIntent({ ...baseIntent, finalAsset: "" }),
      ).toThrow(/finalAsset/);
    });

    it("rejects non-solana destination", () => {
      expect(() =>
        validateIntent({ ...baseIntent, destinationChain: "near" }),
      ).toThrow(/destinationChain/);
    });
  });

  describe("sourceAmount validation", () => {
    it("rejects non-numeric sourceAmount", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: "1.5" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects empty sourceAmount", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: "" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects negative sourceAmount", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: "-100" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects zero sourceAmount", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: "0" }),
      ).toThrow(/sourceAmount.*positive/i);
    });

    it("rejects sourceAmount with letters", () => {
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: "100abc" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects sourceAmount exceeding max value", () => {
      const hugeAmount = (2n ** 129n).toString();
      expect(() =>
        validateIntent({ ...baseIntent, sourceAmount: hugeAmount }),
      ).toThrow(/sourceAmount.*maximum/i);
    });

    it("accepts large valid sourceAmount", () => {
      const largeAmount = (2n ** 64n).toString();
      const validated = validateIntent({ ...baseIntent, sourceAmount: largeAmount });
      expect(validated.sourceAmount).toBe(largeAmount);
    });
  });

  describe("destinationAmount validation", () => {
    it("rejects non-numeric destinationAmount", () => {
      expect(() =>
        validateIntent({ ...baseIntent, destinationAmount: "abc" }),
      ).toThrow(/destinationAmount/);
    });

    it("allows undefined destinationAmount", () => {
      const { destinationAmount, ...intentWithoutDestAmount } = baseIntent;
      const validated = validateIntent(intentWithoutDestAmount as IntentMessage);
      expect(validated.destinationAmount).toBeUndefined();
    });

    it("accepts valid numeric destinationAmount", () => {
      const validated = validateIntent({ ...baseIntent, destinationAmount: "500000" });
      expect(validated.destinationAmount).toBe("500000");
    });
  });

  describe("Kamino deposit validation", () => {
    const kaminoDepositMetadata: KaminoDepositMetadata = {
      action: "kamino-deposit",
      marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };

    it("accepts valid kamino deposit intent", () => {
      const validated = validateIntent({
        ...baseIntent,
        metadata: kaminoDepositMetadata,
      });
      expect(validated.metadata).toEqual(kaminoDepositMetadata);
    });

    it("rejects kamino deposit without marketAddress", () => {
      const invalidMeta = {
        action: "kamino-deposit" as const,
        marketAddress: "",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };
      expect(() =>
        validateIntent({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/marketAddress/);
    });

    it("rejects kamino deposit without mintAddress", () => {
      const invalidMeta = {
        action: "kamino-deposit" as const,
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "",
      };
      expect(() =>
        validateIntent({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/mintAddress/);
    });

    it("accepts kamino deposit with optional useIntents", () => {
      const metaWithIntents: KaminoDepositMetadata = {
        ...kaminoDepositMetadata,
        useIntents: true,
        slippageTolerance: 100,
      };
      const validated = validateIntent({
        ...baseIntent,
        metadata: metaWithIntents,
      });
      expect((validated.metadata as KaminoDepositMetadata).useIntents).toBe(true);
    });
  });

  describe("Kamino withdraw validation", () => {
    const kaminoWithdrawMetadata: KaminoWithdrawMetadata = {
      action: "kamino-withdraw",
      marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };

    it("accepts valid kamino withdraw intent", () => {
      const validated = validateIntent({
        ...baseIntent,
        metadata: kaminoWithdrawMetadata,
      });
      expect(validated.metadata).toEqual(kaminoWithdrawMetadata);
    });

    it("rejects kamino withdraw without marketAddress", () => {
      const invalidMeta = {
        action: "kamino-withdraw" as const,
        marketAddress: "",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };
      expect(() =>
        validateIntent({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/marketAddress/);
    });

    it("rejects kamino withdraw without mintAddress", () => {
      const invalidMeta = {
        action: "kamino-withdraw" as const,
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "",
      };
      expect(() =>
        validateIntent({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/mintAddress/);
    });

    it("accepts kamino withdraw with bridgeBack configuration", () => {
      const metaWithBridge: KaminoWithdrawMetadata = {
        ...kaminoWithdrawMetadata,
        bridgeBack: {
          destinationChain: "zcash",
          destinationAddress: "t1abc...",
          destinationAsset: "zec:zec",
          slippageTolerance: 200,
        },
      };
      const validated = validateIntent({
        ...baseIntent,
        metadata: metaWithBridge,
      });
      expect((validated.metadata as KaminoWithdrawMetadata).bridgeBack).toBeDefined();
    });
  });

  describe("non-Kamino metadata", () => {
    it("accepts generic metadata without action field", () => {
      const validated = validateIntent({
        ...baseIntent,
        metadata: { customField: "value" },
      });
      expect(validated.metadata).toEqual({ customField: "value" });
    });

    it("accepts intent without metadata", () => {
      const validated = validateIntent(baseIntent);
      expect(validated.metadata).toBeUndefined();
    });
  });
});
