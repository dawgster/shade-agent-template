import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import intentsApp from "./intents";
import { config } from "../config";
import { OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";

const { enqueueIntentMock, setStatusMock } = vi.hoisted(() => ({
  enqueueIntentMock: vi.fn(),
  setStatusMock: vi.fn(),
}));

const { getQuoteMock } = vi.hoisted(() => ({
  getQuoteMock: vi.fn(),
}));

vi.mock("../queue/redis", () => ({
  RedisQueueClient: vi.fn().mockImplementation(() => ({
    enqueueIntent: enqueueIntentMock,
  })),
}));

vi.mock("../state/status", () => ({
  setStatus: setStatusMock,
}));

vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({
  OneClickService: {
    getQuote: getQuoteMock,
  },
  OpenAPI: {},
}));

const app = new Hono().route("/api/intents", intentsApp);

const baseIntent = {
  intentId: "abc",
  sourceChain: "solana",
  destinationChain: "solana",
  sourceAsset: "So11111111111111111111111111111111111111111",
  intermediateAsset: "So11111111111111111111111111111111111111111",
  finalAsset: "So11111111111111111111111111111111111111111",
  sourceAmount: "1000",
  destinationAmount: "1000",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
  // Required verification proof (deposit-verified)
  originTxHash: "test-tx-hash-12345",
  intentsDepositAddress: "deposit-addr-12345",
};

describe("intents route", () => {
  beforeEach(() => {
    enqueueIntentMock.mockReset();
    setStatusMock.mockReset();
    config.enableQueue = true;
  });

  it("accepts a valid intent with deposit proof and enqueues", async () => {
    const res = await app.request("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseIntent),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.intentId).toBe("abc");
    expect(body.state).toBe("pending");
    expect(enqueueIntentMock).toHaveBeenCalledTimes(1);
    expect(setStatusMock).toHaveBeenCalledWith("abc", { state: "pending" });
  });

  it("returns 403 when verification proof is missing", async () => {
    const intentWithoutProof = {
      ...baseIntent,
      originTxHash: undefined,
      intentsDepositAddress: undefined,
    };

    const res = await app.request("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intentWithoutProof),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("verification");
    expect(enqueueIntentMock).not.toHaveBeenCalled();
  });

  it("returns 400 on validation error (with valid proof)", async () => {
    const res = await app.request("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseIntent, destinationChain: "near" }),
    });

    expect(res.status).toBe(400);
    expect(enqueueIntentMock).not.toHaveBeenCalled();
  });

  it("returns 503 when queue disabled", async () => {
    config.enableQueue = false;

    const res = await app.request("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseIntent),
    });

    expect(res.status).toBe(503);
    expect(enqueueIntentMock).not.toHaveBeenCalled();
  });
});

describe("intents quote route", () => {
  beforeEach(() => {
    config.intentsQuoteUrl = "https://intents.example/quote";
    getQuoteMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns combined quote with destination asset amount", async () => {
    getQuoteMock.mockResolvedValue({
      timestamp: "2020-01-01T00:00:00Z",
      signature: "sig",
      quote: { amountOut: "1000", depositAddress: "addr" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ outAmount: "500" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as any);

    const res = await app.request("/api/intents/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originAsset: "nep141:wrap.near",
        destinationAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "100",
        swapType: "EXACT_INPUT",
        slippageTolerance: 50,
        recipient: "dest",
        recipientType: "DESTINATION_CHAIN",
        refundTo: "refund",
        refundType: "ORIGIN_CHAIN",
        depositType: "ORIGIN_CHAIN",
        deadline: "2020-01-01T00:00:00Z",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.amountOut).toBe("500");
    expect(body.quoteRequest.destinationAsset).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getQuoteMock).toHaveBeenCalledTimes(1);
  });

  it("errors when config missing", async () => {
    config.intentsQuoteUrl = "";
    OpenAPI.BASE = "";
    const res = await app.request("/api/intents/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originAsset: "nep141:wrap.near",
        destinationAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "100",
        swapType: "EXACT_INPUT",
        slippageTolerance: 50,
        recipient: "dest",
        recipientType: "DESTINATION_CHAIN",
        refundTo: "refund",
        refundType: "ORIGIN_CHAIN",
        depositType: "ORIGIN_CHAIN",
        deadline: "2020-01-01T00:00:00Z",
      }),
    });
    expect(res.status).toBe(500);
  });
});
