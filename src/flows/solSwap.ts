import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import { VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import { extractSolanaMintAddress } from "../constants";
import { ValidatedIntent } from "../queue/types";
import {
  attachSignatureToVersionedTx,
  broadcastSolanaTx,
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
} from "../utils/solana";
import { parseSignature } from "../utils/signature";
import { fetchWithRetry } from "../utils/http";

const { uint8ArrayToHex } = utils.cryptography;

interface SwapExecutionResult {
  txId: string;
}

export async function executeSolanaSwapFlow(
  intent: ValidatedIntent,
): Promise<SwapExecutionResult> {
  if (config.dryRunSwaps) {
    return { txId: `dry-run-${intent.intentId}` };
  }

  const { transaction } = await buildJupiterSwapTransaction(intent);
  const signature = await signWithNearChainSignatures(
    transaction.message.serialize(),
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  const txId = await broadcastSolanaTx(finalized);

  return { txId };
}

async function buildJupiterSwapTransaction(
  intent: ValidatedIntent,
): Promise<{ transaction: VersionedTransaction; agentPublicKey: string }> {
  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );

  // Extract raw Solana mint addresses from asset IDs (handles 1cs_v1:sol:spl:mint format)
  const inputMint = extractSolanaMintAddress(intent.intermediateAsset || intent.sourceAsset); // asset delivered by first-leg swap (e.g. wrapped SOL)
  const outputMint = extractSolanaMintAddress(intent.finalAsset); // SPL mint address for token X
  const amount = intent.destinationAmount || intent.sourceAmount; // amount available on destination chain for second leg

  const clusterParam = config.jupiterCluster
    ? `&cluster=${config.jupiterCluster}`
    : "";
  const quoteUrl = `${config.jupiterBaseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${intent.slippageBps}${clusterParam}`;
  const quoteRes = await fetchWithRetry(
    quoteUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!quoteRes.ok) {
    const body = await quoteRes.text().catch(() => "");
    throw new Error(
      `Jupiter quote failed: ${quoteRes.status} ${quoteRes.statusText}${body ? ` - ${body}` : ""}`,
    );
  }
  const quote = await quoteRes.json();

  const swapRes = await fetchWithRetry(
    `${config.jupiterBaseUrl}/swap`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        destinationWallet: intent.userDestination,
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: "auto",
        ...(config.jupiterCluster ? { asLegacyTransaction: config.jupiterCluster !== "mainnet" } : {}),
      }),
    },
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );

  if (!swapRes.ok) {
    throw new Error(`Jupiter swap failed: ${swapRes.statusText}`);
  }

  const { swapTransaction } = await swapRes.json();
  if (!swapTransaction) throw new Error("Jupiter swap response missing tx");

  const txBuffer = Buffer.from(swapTransaction, "base64");
  const transaction = VersionedTransaction.deserialize(txBuffer);

  return { transaction, agentPublicKey: agentPublicKey.toBase58() };
}

async function signWithNearChainSignatures(
  payloadBytes: Uint8Array,
): Promise<Uint8Array> {
  if (!config.shadeContractId) {
    throw new Error("NEXT_PUBLIC_contractId not configured for signing");
  }

  const payload = uint8ArrayToHex(payloadBytes);
  const signRes = await requestSignature({
    path: SOLANA_DEFAULT_PATH,
    payload,
    keyType: "Eddsa",
  });

  if (!signRes.signature) {
    throw new Error("Signature missing from chain-signature response");
  }

  const sig = parseSignature(signRes.signature);
  if (!sig) throw new Error("Unsupported signature encoding");
  return sig;
}
