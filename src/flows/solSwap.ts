import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { config } from "../config";
import { extractSolanaMintAddress } from "../constants";
import { ValidatedIntent } from "../queue/types";
import {
  attachSignatureToVersionedTx,
  broadcastSolanaTx,
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaConnection,
} from "../utils/solana";
import { signWithNearChainSignatures } from "../utils/chainSignature";
import { fetchWithRetry } from "../utils/http";

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
  // Sign with derivation path that includes userDestination for custody isolation
  const signature = await signWithNearChainSignatures(
    transaction.message.serialize(),
    intent.userDestination,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  const txId = await broadcastSolanaTx(finalized);

  return { txId };
}

async function buildJupiterSwapTransaction(
  intent: ValidatedIntent,
): Promise<{ transaction: VersionedTransaction; agentPublicKey: string }> {
  // Validate userDestination is set - tokens should go to user, not agent
  if (!intent.userDestination) {
    throw new Error(`[solSwap] Missing userDestination for intent ${intent.intentId}`);
  }

  // Derive agent's Solana address with userDestination in path for custody isolation
  // This ensures each user's funds flow through a unique derived account
  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );

  // Extract raw Solana mint addresses from asset IDs (handles 1cs_v1:sol:spl:mint format)
  const inputMint = extractSolanaMintAddress(intent.intermediateAsset || intent.sourceAsset);
  const outputMint = extractSolanaMintAddress(intent.finalAsset);

  // Use intermediateAmount (SOL lamports from intents swap) for Jupiter swap input
  const rawAmount = intent.intermediateAmount || intent.destinationAmount || intent.sourceAmount;

  // Reserve SOL for ATA creation rent and transaction fees
  // ATA rent is ~0.00203 SOL (2,039,280 lamports), add buffer for tx fees
  const ATA_RENT_LAMPORTS = BigInt(2_100_000); // ~0.0021 SOL buffer for ATA + fees
  const rawAmountBigInt = BigInt(rawAmount);
  const swapAmount = rawAmountBigInt > ATA_RENT_LAMPORTS
    ? (rawAmountBigInt - ATA_RENT_LAMPORTS).toString()
    : rawAmount; // If amount is tiny, just try the full amount

  console.log(`[solSwap] Amount adjustment for ATA rent`, {
    rawAmount,
    swapAmount,
    reserved: ATA_RENT_LAMPORTS.toString(),
  });

  const amount = swapAmount;

  const userWallet = new PublicKey(intent.userDestination);
  const outputMintPubkey = new PublicKey(outputMint);
  const userAta = getAssociatedTokenAddressSync(outputMintPubkey, userWallet);

  console.log(`[solSwap] Jupiter swap request`, {
    inputMint,
    outputMint,
    amount,
    agentPublicKey: agentPublicKey.toBase58(),
    userDestination: intent.userDestination,
    userAta: userAta.toBase58(),
    intentId: intent.intentId,
  });

  // Get quote
  const clusterParam = config.jupiterCluster ? `&cluster=${config.jupiterCluster}` : "";
  const quoteUrl = `${config.jupiterBaseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${intent.slippageBps}${clusterParam}`;

  const quoteRes = await fetchWithRetry(
    quoteUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!quoteRes.ok) {
    const body = await quoteRes.text().catch(() => "");
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${quoteRes.statusText}${body ? ` - ${body}` : ""}`);
  }
  const quote = await quoteRes.json();

  // Get swap instructions (not the serialized transaction)
  const swapInstructionsRes = await fetchWithRetry(
    `${config.jupiterBaseUrl}/swap-instructions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        destinationTokenAccount: userAta.toBase58(),
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: "auto",
      }),
    },
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );

  if (!swapInstructionsRes.ok) {
    const body = await swapInstructionsRes.text().catch(() => "");
    throw new Error(`Jupiter swap-instructions failed: ${swapInstructionsRes.status} ${body}`);
  }

  const swapInstructions = await swapInstructionsRes.json();

  // Build instructions array following Jupiter's recommended order
  const instructions: TransactionInstruction[] = [];

  // 1. Add compute budget instructions from Jupiter (should be first)
  if (swapInstructions.computeBudgetInstructions) {
    for (const ix of swapInstructions.computeBudgetInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  // 2. Add ATA creation instruction for user's destination (idempotent - won't fail if exists)
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    agentPublicKey, // payer
    userAta, // ata address
    userWallet, // owner
    outputMintPubkey, // mint
  );
  instructions.push(createAtaIx);

  // 3. Add setup instructions from Jupiter (e.g., creating intermediate token accounts)
  if (swapInstructions.setupInstructions) {
    for (const ix of swapInstructions.setupInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  // 4. Add the main swap instruction
  if (swapInstructions.swapInstruction) {
    instructions.push(deserializeInstruction(swapInstructions.swapInstruction));
  }

  // 5. Add cleanup instruction from Jupiter (e.g., unwrapping SOL)
  if (swapInstructions.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapInstructions.cleanupInstruction));
  }

  // 6. Add other instructions from Jupiter (e.g., Jito tips)
  if (swapInstructions.otherInstructions) {
    for (const ix of swapInstructions.otherInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  // Get address lookup tables
  const connection = getSolanaConnection();
  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    connection,
    swapInstructions.addressLookupTableAddresses || [],
  );

  // Build the versioned transaction
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  const transaction = new VersionedTransaction(messageV0);

  return { transaction, agentPublicKey: agentPublicKey.toBase58() };
}

function deserializeInstruction(instruction: {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

async function getAddressLookupTableAccounts(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];

  const accounts = await connection.getMultipleAccountsInfo(
    addresses.map((addr) => new PublicKey(addr)),
  );

  return accounts
    .map((account, index) => {
      if (!account) return null;
      return new AddressLookupTableAccount({
        key: new PublicKey(addresses[index]),
        state: AddressLookupTableAccount.deserialize(account.data),
      });
    })
    .filter((account): account is AddressLookupTableAccount => account !== null);
}
