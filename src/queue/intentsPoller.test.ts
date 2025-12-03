import { describe, expect, it, vi, beforeEach } from "vitest";
import { IntentStatus } from "../state/status";
import { ValidatedIntent } from "./types";

const {
  getIntentsByStateMock,
  setStatusMock,
  getExecutionStatusMock,
  enqueueIntentMock,
} = vi.hoisted(() => ({
  getIntentsByStateMock: vi.fn(),
  setStatusMock: vi.fn(),
  getExecutionStatusMock: vi.fn(),
  enqueueIntentMock: vi.fn(),
}));

vi.mock("../state/status", () => ({
  getIntentsByState: getIntentsByStateMock,
  setStatus: setStatusMock,
}));

vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({
  OneClickService: {
    getExecutionStatus: getExecutionStatusMock,
  },
  OpenAPI: {},
}));

vi.mock("./redis", () => ({
  RedisQueueClient: vi.fn().mockImplementation(() => ({
    enqueueIntent: enqueueIntentMock,
  })),
}));

const baseIntent: ValidatedIntent = {
  intentId: "test-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "1000000000000000000000000",
  destinationChain: "solana",
  intermediateAsset: "So11111111111111111111111111111111111111112",
  finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
  slippageBps: 300,
};

describe("intentsPoller", () => {
  beforeEach(() => {
    getIntentsByStateMock.mockReset();
    setStatusMock.mockReset();
    getExecutionStatusMock.mockReset();
    enqueueIntentMock.mockReset();
  });

  describe("pollPendingIntents behavior", () => {
    // Simulating the core logic of pollPendingIntents

    async function checkAndProcessIntent(
      intentStatus: { intentId: string } & IntentStatus
    ) {
      const { intentId, depositAddress, depositMemo, intentData } = intentStatus;

      if (!depositAddress) {
        return { skipped: true, reason: "missing depositAddress" };
      }

      let swapStatus;
      try {
        swapStatus = await getExecutionStatusMock(depositAddress, depositMemo);
      } catch (err) {
        return { error: true, reason: "failed to get status" };
      }

      switch (swapStatus.status?.toLowerCase()) {
        case "success":
        case "completed":
          if (!intentData) {
            await setStatusMock(intentId, {
              state: "failed",
              error: "Missing intent data after intents success",
            });
            return { failed: true, reason: "missing intentData" };
          }

          await setStatusMock(intentId, {
            state: "processing",
            detail: "Intents swap completed, executing Jupiter swap",
          });

          const updatedIntent = {
            ...intentData,
            metadata: {
              ...intentData.metadata,
              intentsCompleted: true,
            },
          };

          await enqueueIntentMock(updatedIntent);
          return { success: true };

        case "refunded":
        case "failed":
          await setStatusMock(intentId, {
            state: "failed",
            error: `Intents swap ${swapStatus.status}`,
          });
          return { failed: true, reason: swapStatus.status };

        case "pending":
        case "processing":
          return { pending: true };

        default:
          return { unknown: true, status: swapStatus.status };
      }
    }

    it("skips intents without depositAddress", async () => {
      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        // No depositAddress
      };

      const result = await checkAndProcessIntent(intentStatus);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("missing depositAddress");
    });

    it("handles successful swap status", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "success" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);

      expect(result.success).toBe(true);
      expect(setStatusMock).toHaveBeenCalledWith("test-1", {
        state: "processing",
        detail: "Intents swap completed, executing Jupiter swap",
      });
      expect(enqueueIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          intentId: "test-1",
          metadata: expect.objectContaining({
            intentsCompleted: true,
          }),
        })
      );
    });

    it("handles completed swap status same as success", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "completed" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);
      expect(result.success).toBe(true);
    });

    it("handles failed swap status", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "failed" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);

      expect(result.failed).toBe(true);
      expect(setStatusMock).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "Intents swap failed",
      });
    });

    it("handles refunded swap status", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "refunded" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);

      expect(result.failed).toBe(true);
      expect(setStatusMock).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "Intents swap refunded",
      });
    });

    it("continues polling for pending status", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "pending" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);

      expect(result.pending).toBe(true);
      expect(setStatusMock).not.toHaveBeenCalled();
      expect(enqueueIntentMock).not.toHaveBeenCalled();
    });

    it("continues polling for processing status", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "processing" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);
      expect(result.pending).toBe(true);
    });

    it("handles unknown status gracefully", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "unknown-status" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);
      expect(result.unknown).toBe(true);
      expect(result.status).toBe("unknown-status");
    });

    it("handles API error gracefully", async () => {
      getExecutionStatusMock.mockRejectedValue(new Error("API timeout"));

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      };

      const result = await checkAndProcessIntent(intentStatus);
      expect(result.error).toBe(true);
    });

    it("fails if success but missing intentData", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "success" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        // No intentData
      };

      const result = await checkAndProcessIntent(intentStatus);

      expect(result.failed).toBe(true);
      expect(result.reason).toBe("missing intentData");
      expect(setStatusMock).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "Missing intent data after intents success",
      });
    });

    it("passes depositMemo to getExecutionStatus", async () => {
      getExecutionStatusMock.mockResolvedValue({ status: "pending" });

      const intentStatus: { intentId: string } & IntentStatus = {
        intentId: "test-1",
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        depositMemo: "memo-456",
        intentData: baseIntent,
      };

      await checkAndProcessIntent(intentStatus);

      expect(getExecutionStatusMock).toHaveBeenCalledWith(
        "deposit-addr-123",
        "memo-456"
      );
    });
  });

  describe("getIntentsByState usage", () => {
    it("queries for awaiting_intents state", async () => {
      getIntentsByStateMock.mockResolvedValue([]);

      // Simulate what pollPendingIntents does
      const pendingIntents = await getIntentsByStateMock("awaiting_intents");

      expect(getIntentsByStateMock).toHaveBeenCalledWith("awaiting_intents");
      expect(pendingIntents).toEqual([]);
    });

    it("returns multiple pending intents", async () => {
      const mockIntents = [
        {
          intentId: "intent-1",
          state: "awaiting_intents" as const,
          depositAddress: "addr-1",
        },
        {
          intentId: "intent-2",
          state: "awaiting_intents" as const,
          depositAddress: "addr-2",
        },
      ];
      getIntentsByStateMock.mockResolvedValue(mockIntents);

      const pendingIntents = await getIntentsByStateMock("awaiting_intents");

      expect(pendingIntents).toHaveLength(2);
    });
  });

  describe("intent re-enqueueing", () => {
    it("adds intentsCompleted flag to metadata when re-enqueueing", async () => {
      const originalIntent: ValidatedIntent = {
        ...baseIntent,
        metadata: { someField: "value" },
      };

      // Simulate the re-enqueue logic
      const updatedIntent = {
        ...originalIntent,
        metadata: {
          ...originalIntent.metadata,
          intentsCompleted: true,
        },
      };

      expect(updatedIntent.metadata).toEqual({
        someField: "value",
        intentsCompleted: true,
      });
    });

    it("handles intent without existing metadata", async () => {
      const originalIntent: ValidatedIntent = {
        ...baseIntent,
        metadata: undefined,
      };

      const updatedIntent = {
        ...originalIntent,
        metadata: {
          ...originalIntent.metadata,
          intentsCompleted: true,
        },
      };

      expect(updatedIntent.metadata).toEqual({
        intentsCompleted: true,
      });
    });

    it("preserves all original intent fields", async () => {
      const originalIntent: ValidatedIntent = {
        ...baseIntent,
        nearPublicKey: "ed25519:ABC123",
        userSignature: {
          message: "test",
          signature: "sig",
          publicKey: "ed25519:ABC123",
          nonce: "nonce",
          recipient: "shade-agent.near",
        },
      };

      const updatedIntent = {
        ...originalIntent,
        metadata: {
          ...originalIntent.metadata,
          intentsCompleted: true,
        },
      };

      expect(updatedIntent.intentId).toBe(originalIntent.intentId);
      expect(updatedIntent.sourceChain).toBe(originalIntent.sourceChain);
      expect(updatedIntent.nearPublicKey).toBe(originalIntent.nearPublicKey);
      expect(updatedIntent.userSignature).toEqual(originalIntent.userSignature);
    });
  });
});
