import { Hono } from "hono";
import { RedisQueueClient } from "../queue/redis";
import { IntentMessage } from "../queue/types";
import { validateIntent } from "../queue/validation";
import { setStatus } from "../state/status";
import { config } from "../config";
import { fetchWithRetry } from "../utils/http";
import { SOL_NATIVE_MINT, extractSolanaMintAddress } from "../constants";
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";

const app = new Hono();
const queueClient = new RedisQueueClient();

type QuoteRequestBody = QuoteRequest;

interface IntentsQuoteResponse {
  timestamp?: string;
  signature?: string;
  quoteRequest?: Record<string, unknown>;
  quote: Record<string, any>;
}

app.post("/", async (c) => {
  if (!config.enableQueue) {
    return c.json({ error: "Queue consumer is disabled" }, 503);
  }

  let payload: IntentMessage;
  try {
    payload = await c.req.json<IntentMessage>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let validatedIntent;
  try {
    validatedIntent = validateIntent(payload);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    await queueClient.enqueueIntent(validatedIntent);
    await setStatus(validatedIntent.intentId, { state: "pending" });
    return c.json(
      { intentId: validatedIntent.intentId, state: "pending" },
      202,
    );
  } catch (err) {
    console.error("Failed to enqueue intent", err);
    return c.json({ error: "Failed to enqueue intent" }, 500);
  }
});

app.post("/quote", async (c) => {
  if (!config.intentsQuoteUrl && !OpenAPI.BASE) {
    return c.json({ error: "INTENTS_QUOTE_URL is not configured" }, 500);
  }

  let payload: QuoteRequestBody;
  try {
    payload = await c.req.json<QuoteRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!payload.originAsset || !payload.destinationAsset || !payload.amount) {
    return c.json(
      { error: "originAsset, destinationAsset, and amount are required" },
      400,
    );
  }

  // Respect dry flag from request - dry: true for preview, dry: false for execution (to get depositAddress)
  const isDryRun = payload.dry !== false;

  const solQuoteRequest = {
    ...payload,
    destinationAsset: `sol:${SOL_NATIVE_MINT}`,
    dry: isDryRun,
  };

  if (config.intentsQuoteUrl) {
    OpenAPI.BASE = config.intentsQuoteUrl;
  }

  console.info("[intents/quote] requesting SOL leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      solQuoteRequest,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }
  const baseQuote = intentsQuote.quote || {};
  const solAmount =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amountIn ||
    baseQuote.amount;
  if (!solAmount) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Extract raw Solana mint address from asset ID (handles 1cs_v1:sol:spl:mint format)
  const outputMint = extractSolanaMintAddress(payload.destinationAsset);

  const clusterParam = config.jupiterCluster
    ? `&cluster=${config.jupiterCluster}`
    : "";
  const jupiterUrl = `${config.jupiterBaseUrl}/quote?inputMint=${SOL_NATIVE_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${solAmount}&slippageBps=${payload.slippageTolerance}${clusterParam}`;
  console.info("[intents/quote] requesting Jupiter leg", {
    url: jupiterUrl,
  });
  const jupiterRes = await fetchWithRetry(
    jupiterUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!jupiterRes.ok) {
    const body = await jupiterRes.text().catch(() => "");
    console.error("[intents/quote] Jupiter quote failed", {
      status: jupiterRes.status,
      body,
    });
    return c.json(
      { error: `Jupiter quote failed: ${jupiterRes.status} ${body}` },
      502,
    );
  }
  const jupiterQuote = (await jupiterRes.json()) as { outAmount?: string };
  const outAmount = jupiterQuote.outAmount;
  if (!outAmount) {
    console.error("[intents/quote] Jupiter quote missing outAmount", jupiterQuote);
    return c.json({ error: "Jupiter quote missing outAmount" }, 502);
  }

  // Generate a quote ID for tracking (use 1-Click quoteId if available, otherwise generate one)
  const quoteId = baseQuote.quoteId || `shade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return c.json({
    timestamp: intentsQuote.timestamp || new Date().toISOString(),
    signature: intentsQuote.signature || "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      ...baseQuote,
      quoteId,
      amountOut: outAmount,
      minAmountOut: outAmount,
      destinationAsset: payload.destinationAsset,
      // Include depositAddress and depositMemo from 1-Click quote (only present when dry: false)
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
    },
  });
});

export default app;
