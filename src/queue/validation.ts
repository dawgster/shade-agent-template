import { SOL_NATIVE_MINT } from "../constants";
import {
  IntentMessage,
  KaminoDepositMetadata,
  KaminoWithdrawMetadata,
  ValidatedIntent,
} from "./types";

const DEFAULT_SLIPPAGE_BPS = 300; // 3% fallback if UI omits slippage

function isKaminoDepositMetadata(
  metadata?: IntentMessage["metadata"],
): boolean {
  return (metadata as KaminoDepositMetadata)?.action === "kamino-deposit";
}

function isKaminoWithdrawMetadata(
  metadata?: IntentMessage["metadata"],
): boolean {
  return (metadata as KaminoWithdrawMetadata)?.action === "kamino-withdraw";
}

export function validateIntent(message: IntentMessage): ValidatedIntent {
  if (!message.intentId) throw new Error("intentId missing");
  if (message.destinationChain !== "solana")
    throw new Error("destinationChain must be solana");
  if (!message.userDestination) throw new Error("userDestination missing");
  if (!message.agentDestination) throw new Error("agentDestination missing");
  if (!message.sourceAsset) throw new Error("sourceAsset missing");
  if (!message.finalAsset) throw new Error("finalAsset missing");
  if (!message.sourceAmount || !/^\d+$/.test(message.sourceAmount)) {
    throw new Error("sourceAmount must be a numeric string in base units");
  }
  // destinationAmount is optional - if provided, must be numeric string
  if (
    message.destinationAmount !== undefined &&
    !/^\d+$/.test(message.destinationAmount)
  ) {
    throw new Error(
      "destinationAmount must be a numeric string in base units if provided",
    );
  }

  // Validate Kamino-specific requirements
  if (isKaminoDepositMetadata(message.metadata)) {
    validateKaminoDepositIntent(message);
  }
  if (isKaminoWithdrawMetadata(message.metadata)) {
    validateKaminoWithdrawIntent(message);
  }

  const intermediateAsset =
    message.intermediateAsset || getDefaultIntermediateAsset(message);

  return {
    ...message,
    intermediateAsset,
    slippageBps:
      typeof message.slippageBps === "number"
        ? message.slippageBps
        : DEFAULT_SLIPPAGE_BPS,
  };
}

function validateKaminoDepositIntent(message: IntentMessage): void {
  const metadata = message.metadata as KaminoDepositMetadata;

  if (!metadata.marketAddress) {
    throw new Error("Kamino deposit requires metadata.marketAddress");
  }
  if (!metadata.mintAddress) {
    throw new Error("Kamino deposit requires metadata.mintAddress");
  }

  // Note: nearPublicKey and userSignature are validated at runtime in the flow
  // because they may be added after initial validation
}

function validateKaminoWithdrawIntent(message: IntentMessage): void {
  const metadata = message.metadata as KaminoWithdrawMetadata;

  if (!metadata.marketAddress) {
    throw new Error("Kamino withdraw requires metadata.marketAddress");
  }
  if (!metadata.mintAddress) {
    throw new Error("Kamino withdraw requires metadata.mintAddress");
  }

  // Note: nearPublicKey and userSignature are validated at runtime in the flow
  // because they may be added after initial validation
}

function getDefaultIntermediateAsset(intent: IntentMessage) {
  if (intent.destinationChain === "solana") return SOL_NATIVE_MINT;
  throw new Error("intermediateAsset missing");
}
