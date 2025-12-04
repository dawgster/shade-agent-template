import { Hono } from "hono";
import { RedisQueueClient } from "../queue/redis";
import { IntentMessage, IntentChain } from "../queue/types";
import { validateIntent } from "../queue/validation";
import { setStatus } from "../state/status";
import { config } from "../config";
import { fetchWithRetry } from "../utils/http";
import { SOL_NATIVE_MINT, extractSolanaMintAddress } from "../constants";
import { getSolDefuseAssetId } from "../utils/tokenMappings";
import { deriveAgentPublicKey } from "../utils/solana";
import { verifyNearSignature } from "../utils/nearSignature";
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";

const app = new Hono();
const queueClient = new RedisQueueClient();

type QuoteRequestBody = QuoteRequest & {
  // Additional fields for intent enqueuing (required when dry: false)
  sourceChain?: IntentChain;
  userDestination?: string;
  metadata?: Record<string, unknown>;
  // Kamino-specific fields
  kaminoDeposit?: {
    marketAddress: string;
    mintAddress: string;
  };
};

interface IntentsQuoteResponse {
  timestamp?: string;
  signature?: string;
  quoteRequest?: Record<string, unknown>;
  quote: Record<string, any>;
}

/**
 * POST /api/intents - Enqueue an intent for processing
 *
 * SECURITY: This endpoint requires valid verification proof:
 * 1. Deposit-verified intents: Must have originTxHash + intentsDepositAddress
 *    (Used for Kamino deposits where the deposit tx is the authorization)
 * 2. Signature-verified intents: Must have valid userSignature (NEP-413)
 *    (Used for Kamino withdrawals where there's no deposit)
 *
 * Regular swaps should NOT use this endpoint - they are auto-enqueued
 * when requesting a quote with dry: false via POST /api/intents/quote
 */
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

  // Verify the intent has valid authorization proof
  const hasDepositProof = payload.originTxHash && payload.intentsDepositAddress;
  const hasSignatureProof = payload.userSignature;

  if (!hasDepositProof && !hasSignatureProof) {
    console.warn("[intents] Rejected intent without verification proof", {
      intentId: payload.intentId,
      hasOriginTxHash: !!payload.originTxHash,
      hasDepositAddress: !!payload.intentsDepositAddress,
      hasSignature: !!payload.userSignature,
    });
    return c.json({
      error: "Intent requires verification: either originTxHash + intentsDepositAddress (for deposits) or userSignature (for withdrawals)"
    }, 403);
  }

  // If signature provided, verify it's valid
  if (hasSignatureProof && payload.userSignature) {
    const isValidSignature = verifyNearSignature(payload.userSignature);
    if (!isValidSignature) {
      console.warn("[intents] Rejected intent with invalid signature", {
        intentId: payload.intentId,
        publicKey: payload.userSignature.publicKey,
      });
      return c.json({ error: "Invalid userSignature" }, 403);
    }
    console.info("[intents] Signature verified for intent", {
      intentId: payload.intentId,
      publicKey: payload.userSignature.publicKey,
    });
  }

  // If deposit proof provided, log it (actual verification happens when processing)
  if (hasDepositProof) {
    console.info("[intents] Deposit-verified intent received", {
      intentId: payload.intentId,
      originTxHash: payload.originTxHash,
      depositAddress: payload.intentsDepositAddress,
    });
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

  // Extract custom fields that should NOT be sent to the Defuse API
  const { sourceChain, userDestination, metadata, kaminoDeposit, ...defuseQuoteFields } = payload;

  // Derive the agent's Solana address for the 1-Click recipient
  // Include userDestination in derivation path for custody isolation
  let agentSolanaAddress: string | undefined;
  if (userDestination) {
    const agentPubkey = await deriveAgentPublicKey(
      undefined,
      userDestination,
    );
    agentSolanaAddress = agentPubkey.toBase58();
  }

  if (config.intentsQuoteUrl) {
    OpenAPI.BASE = config.intentsQuoteUrl;
  }

  // For Kamino deposits, use direct swap to target token (no Jupiter leg needed)
  // Intents delivers the target SPL token directly, then we deposit to Kamino
  if (kaminoDeposit) {
    return handleKaminoDepositQuote(c, payload, defuseQuoteFields, isDryRun, agentSolanaAddress, kaminoDeposit, sourceChain, userDestination, metadata);
  }

  // Regular two-leg swap: First swap origin asset to SOL via Intents, then SOL to final token via Jupiter
  // Use Defuse asset ID format for the SOL destination
  const solDefuseAssetId = getSolDefuseAssetId();
  const solQuoteRequest = {
    ...defuseQuoteFields,
    destinationAsset: solDefuseAssetId,
    dry: isDryRun,
    // Set recipient to the derived agent address so 1-Click delivers SOL there
    ...(agentSolanaAddress && {
      recipient: agentSolanaAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  console.info("[intents/quote] requesting SOL leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentSolanaAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      solQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }
  const baseQuote = intentsQuote.quote || {};
  const rawSolAmount =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amountIn ||
    baseQuote.amount;
  if (!rawSolAmount) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure solAmount is a clean integer string (no decimals, scientific notation, etc.)
  let solAmount: string;
  try {
    solAmount = BigInt(rawSolAmount).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse solAmount as integer", { rawSolAmount });
    return c.json({ error: `Invalid amount format from intents: ${rawSolAmount}` }, 502);
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

  // When dry: false, auto-enqueue the intent (deposit verification happens via 1-Click API)
  // This prevents malicious actors from enqueuing fake intents without going through quote flow
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    // Validate required fields for intent enqueuing
    if (!payload.sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!payload.userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      // Use the agent address we derived earlier for the 1-Click recipient
      // This ensures the same address is used for delivery and signing
      const agentDestination = agentSolanaAddress!;

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain: payload.sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: solAmount,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination: payload.userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: payload.metadata,
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Intent auto-enqueued", {
        intentId: quoteId,
        sourceChain: payload.sourceChain,
        depositAddress: baseQuote.depositAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue intent", err);
      // Don't fail the quote request - intent can be retried
      // The 1-Click API will still track the swap via depositAddress
    }
  }

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

/**
 * Handle Kamino deposit quote requests.
 * For Kamino deposits, we swap directly to the target SPL token via Intents (no Jupiter leg).
 * The flow is: Source asset -> Target SPL token (via Intents) -> Kamino deposit
 */
async function handleKaminoDepositQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Omit<QuoteRequestBody, "sourceChain" | "userDestination" | "metadata" | "kaminoDeposit">,
  isDryRun: boolean,
  agentSolanaAddress: string | undefined,
  kaminoDeposit: { marketAddress: string; mintAddress: string },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  // For Kamino deposits, swap directly to the destination asset (the SPL token to deposit)
  const directQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    // Set recipient to the derived agent address so Intents delivers tokens there
    ...(agentSolanaAddress && {
      recipient: agentSolanaAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  console.info("[intents/quote] Kamino deposit: requesting direct quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentSolanaAddress,
    kaminoMarket: kaminoDeposit.marketAddress,
    kaminoMint: kaminoDeposit.mintAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      directQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Kamino deposit: intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure amount is a clean integer string
  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse amountOut as integer", { rawAmountOut });
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  // Generate a quote ID for tracking
  const quoteId = baseQuote.quoteId || `shade-kamino-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the Kamino deposit intent
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      const agentDestination = agentSolanaAddress!;

      // Build Kamino-specific metadata
      const intentMetadata = {
        ...metadata,
        action: "kamino-deposit",
        marketAddress: kaminoDeposit.marketAddress,
        mintAddress: kaminoDeposit.mintAddress,
        targetDefuseAssetId: payload.destinationAsset,
        useIntents: true,
      };

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: intentMetadata,
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Kamino deposit intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        depositAddress: baseQuote.depositAddress,
        kaminoMarket: kaminoDeposit.marketAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue Kamino intent", err);
    }
  }

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
      amountOut,
      minAmountOut: amountOut,
      destinationAsset: payload.destinationAsset,
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
    },
  });
}

export default app;
