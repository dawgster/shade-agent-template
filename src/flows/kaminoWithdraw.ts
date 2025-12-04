import {
  VersionedTransaction,
  Connection,
  TransactionMessage,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { createSolanaRpc, address } from "@solana/kit";
import {
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import BN from "bn.js";
import { config } from "../config";
import { KaminoWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  attachSignatureToVersionedTx,
  attachMultipleSignaturesToVersionedTx,
  broadcastSolanaTx,
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
} from "../utils/solana";
import {
  signWithNearChainSignatures,
  createDummySigner,
} from "../utils/chainSignature";
import {
  createSolanaIntentSigningMessage,
  validateSolanaIntentSignature,
} from "../utils/solanaSignature";
import { SOL_NATIVE_MINT } from "../constants";
import {
  OneClickService,
  OpenAPI,
} from "@defuse-protocol/one-click-sdk-typescript";
import { getDefuseAssetId, getSolDefuseAssetId } from "../utils/tokenMappings";

interface KaminoWithdrawResult {
  txId: string;
  /** If bridgeBack was configured, contains the bridge transaction ID */
  bridgeTxId?: string;
  /** If bridgeBack was configured, the intents deposit address used */
  intentsDepositAddress?: string;
}

export function isKaminoWithdrawIntent(
  intent: ValidatedIntent,
): intent is ValidatedIntent & { metadata: KaminoWithdrawMetadata } {
  const meta = intent.metadata as KaminoWithdrawMetadata | undefined;
  return meta?.action === "kamino-withdraw" && !!meta.marketAddress && !!meta.mintAddress;
}

function createKaminoRpc() {
  return createSolanaRpc(config.solRpcUrl);
}

/**
 * Verifies that the intent has a valid user signature authorizing the action
 * Throws an error if authorization fails
 */
function verifyUserAuthorization(intent: ValidatedIntent): void {
  // Require userDestination for Kamino withdrawals
  if (!intent.userDestination) {
    throw new Error("Kamino withdraw requires userDestination to identify the user");
  }

  // Require user signature
  if (!intent.userSignature) {
    throw new Error("Kamino withdraw requires userSignature for authorization");
  }

  // Signature must be from Solana destination account
  // Check if it's a NEAR signature (has nonce/recipient) - reject these
  if ("nonce" in intent.userSignature || "recipient" in intent.userSignature) {
    throw new Error("Kamino withdraw requires a Solana signature, not a NEAR signature");
  }

  // Generate the expected message hash for this intent
  const expectedMessage = createSolanaIntentSigningMessage(intent);

  // Validate the signature - must be signed by the userDestination address
  const result = validateSolanaIntentSignature(
    {
      message: intent.userSignature.message,
      signature: intent.userSignature.signature,
      publicKey: intent.userSignature.publicKey,
    },
    intent.userDestination,
    expectedMessage,
  );

  if (!result.isValid) {
    throw new Error(`Authorization failed: ${result.error}`);
  }
}

export async function executeKaminoWithdrawFlow(
  intent: ValidatedIntent,
): Promise<KaminoWithdrawResult> {
  // Verify user authorization via signature
  verifyUserAuthorization(intent);

  const meta = intent.metadata as KaminoWithdrawMetadata;

  if (config.dryRunSwaps) {
    const result: KaminoWithdrawResult = { txId: `dry-run-kamino-withdraw-${intent.intentId}` };
    if (meta.bridgeBack) {
      result.bridgeTxId = `dry-run-bridge-${intent.intentId}`;
      result.intentsDepositAddress = "dry-run-deposit-address";
    }
    return result;
  }

  // Step 1: Execute Kamino withdrawal
  const { transaction, serializedMessage } = await buildKaminoWithdrawTransaction(intent);

  // Transaction requires two signatures:
  // 1. Base agent (fee payer) - pays for gas, index 0
  // 2. User-specific derived account (token owner) - holds kTokens, index 1

  // Sign with base agent (fee payer)
  const feePayerSignature = await signWithNearChainSignatures(
    serializedMessage,
    undefined, // base agent path
  );

  // Sign with user-specific derived account (token owner)
  const userAgentSignature = await signWithNearChainSignatures(
    serializedMessage,
    intent.userDestination,
  );

  const finalized = attachMultipleSignaturesToVersionedTx(transaction, [
    { signature: feePayerSignature, index: 0 },
    { signature: userAgentSignature, index: 1 },
  ]);

  const txId = await broadcastSolanaTx(finalized);

  console.log(`[kaminoWithdraw] Withdrawal tx confirmed: ${txId}`);

  // Step 2: If bridgeBack is configured, send withdrawn tokens to intents
  if (meta.bridgeBack) {
    const bridgeResult = await executeBridgeBack(intent, meta);
    return {
      txId,
      bridgeTxId: bridgeResult.txId,
      intentsDepositAddress: bridgeResult.depositAddress,
    };
  }

  return { txId };
}

async function buildKaminoWithdrawTransaction(
  intent: ValidatedIntent,
): Promise<{ transaction: VersionedTransaction; serializedMessage: Uint8Array }> {
  const rpc = createKaminoRpc();
  const meta = intent.metadata as KaminoWithdrawMetadata;

  // Base agent pays for transaction fees (has SOL)
  const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);

  // User-specific derived account holds kTokens for custody isolation
  const userAgentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );
  const ownerAddress = address(userAgentPublicKey.toBase58());

  // Create a dummy signer - we only need its address, not actual signing capability
  // The actual signing is done via NEAR chain signatures
  const dummySigner = createDummySigner(ownerAddress);

  const market = await KaminoMarket.load(
    rpc,
    address(meta.marketAddress),
    1000, // recentSlotDurationMs
    PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${meta.marketAddress}`);
  }

  const reserve = market.getReserveByMint(address(meta.mintAddress));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${meta.mintAddress}`);
  }

  const amount = new BN(intent.sourceAmount);

  const withdrawAction = await KaminoAction.buildWithdrawTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    dummySigner,
    new VanillaObligation(PROGRAM_ID),
    false,
    undefined,
    300_000,
    true,
  );

  const instructions = [
    ...withdrawAction.computeBudgetIxs,
    ...withdrawAction.setupIxs,
    ...withdrawAction.lendingIxs,
    ...withdrawAction.cleanupIxs,
  ];

  // For broadcasting via @solana/web3.js, we need to convert the transaction
  const connection = new Connection(config.solRpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();

  // Convert kit instructions to web3.js instructions
  // AccountRole values from @solana/instructions:
  // READONLY = 0, WRITABLE = 1, READONLY_SIGNER = 2, WRITABLE_SIGNER = 3
  const web3Instructions = instructions.map((ix: any) => ({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((acc: any) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: acc.role === 2 || acc.role === 3, // READONLY_SIGNER or WRITABLE_SIGNER
      isWritable: acc.role === 1 || acc.role === 3, // WRITABLE or WRITABLE_SIGNER
    })),
    data: Buffer.from(ix.data),
  }));

  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey, // Base agent pays for gas
    recentBlockhash: blockhash,
    instructions: web3Instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  return { transaction, serializedMessage: transaction.message.serialize() };
}

interface BridgeBackResult {
  txId: string;
  depositAddress: string;
}

/**
 * After withdrawing from Kamino, bridges the withdrawn tokens back to the user's
 * destination chain (e.g., ZEC) via NEAR intents.
 *
 * Flow:
 * 1. Request a quote from intents with dry: false to get the deposit address
 * 2. Build a transaction to transfer withdrawn tokens to that deposit address
 * 3. Sign and broadcast the transfer transaction
 * 4. Intents handles the cross-chain swap from there
 */
async function executeBridgeBack(
  intent: ValidatedIntent,
  meta: KaminoWithdrawMetadata,
): Promise<BridgeBackResult> {
  if (!meta.bridgeBack) {
    throw new Error("bridgeBack configuration missing");
  }

  const { destinationChain, destinationAddress, destinationAsset, slippageTolerance } = meta.bridgeBack;
  const mintAddress = meta.mintAddress;
  const withdrawnAmount = intent.sourceAmount;

  console.log(`[kaminoWithdraw] Starting bridge back to ${destinationChain}`, {
    destinationAddress,
    destinationAsset,
    amount: withdrawnAmount,
    mintAddress,
  });

  // Step 1: Get intents quote with dry: false to get deposit address
  if (config.intentsQuoteUrl) {
    OpenAPI.BASE = config.intentsQuoteUrl;
  }

  // Convert Solana mint address to Defuse asset ID
  // For native SOL, use the dedicated function; for SPL tokens, look up by address
  const originAsset =
    mintAddress === SOL_NATIVE_MINT
      ? getSolDefuseAssetId()
      : getDefuseAssetId("solana", mintAddress) || `nep141:${mintAddress}.omft.near`;

  // Create deadline 30 minutes from now
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const quoteRequest = {
    originAsset,
    destinationAsset, // Caller provides this in Defuse format
    amount: String(withdrawnAmount),
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: slippageTolerance ?? 300, // Default 3%
    dry: false, // Important: we need the deposit address
    recipient: destinationAddress,
    recipientType: "DESTINATION_CHAIN" as const,
    refundTo: intent.refundAddress || intent.userDestination,
    refundType: "ORIGIN_CHAIN" as const,
    depositType: "ORIGIN_CHAIN" as const,
    deadline,
  };

  console.log("[kaminoWithdraw] Requesting intents quote", quoteRequest);

  const quoteResponse = await OneClickService.getQuote(quoteRequest as any);

  // Extract deposit address from the quote response
  const depositAddress = (quoteResponse as any).depositAddress;
  if (!depositAddress) {
    throw new Error("Intents quote response missing depositAddress");
  }

  console.log(`[kaminoWithdraw] Got intents deposit address: ${depositAddress}`);

  // Step 2: Build transaction to send tokens to the deposit address
  // Base agent pays for transaction fees (has SOL)
  const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);

  // User-specific derived account holds tokens for custody isolation
  const userAgentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );

  const connection = new Connection(config.solRpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();

  let transferIx;
  const depositPubkey = new PublicKey(depositAddress);

  // Check if this is native SOL or an SPL token
  if (mintAddress === SOL_NATIVE_MINT) {
    // Native SOL transfer - user agent sends SOL
    transferIx = SystemProgram.transfer({
      fromPubkey: userAgentPublicKey,
      toPubkey: depositPubkey,
      lamports: BigInt(withdrawnAmount),
    });
  } else {
    // SPL token transfer
    const mintPubkey = new PublicKey(mintAddress);

    // Get or create associated token accounts
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey,
      userAgentPublicKey,
    );

    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey,
      depositPubkey,
      true, // allowOwnerOffCurve for PDA
    );

    // Check if destination ATA exists
    const destinationAtaInfo = await connection.getAccountInfo(destinationAta);

    const instructions = [];

    // Create destination ATA if it doesn't exist (fee payer pays for this)
    if (!destinationAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          feePayerPublicKey, // payer (base agent pays rent)
          destinationAta, // ata
          depositPubkey, // owner
          mintPubkey, // mint
        ),
      );
    }

    // Add transfer instruction (user agent signs as token owner)
    instructions.push(
      createTransferInstruction(
        sourceAta,
        destinationAta,
        userAgentPublicKey,
        BigInt(withdrawnAmount),
      ),
    );

    // Build transaction with multiple instructions
    const messageV0 = new TransactionMessage({
      payerKey: feePayerPublicKey, // Base agent pays for gas
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const serializedMessage = transaction.message.serialize();

    // Sign with both accounts
    const feePayerSignature = await signWithNearChainSignatures(
      serializedMessage,
      undefined,
    );
    const userAgentSignature = await signWithNearChainSignatures(
      serializedMessage,
      intent.userDestination,
    );

    const finalized = attachMultipleSignaturesToVersionedTx(transaction, [
      { signature: feePayerSignature, index: 0 },
      { signature: userAgentSignature, index: 1 },
    ]);

    const txId = await broadcastSolanaTx(finalized);

    console.log(`[kaminoWithdraw] Bridge transfer tx confirmed: ${txId}`);

    return { txId, depositAddress };
  }

  // For native SOL, build a simple transfer transaction
  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey, // Base agent pays for gas
    recentBlockhash: blockhash,
    instructions: [transferIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  const serializedMessage = transaction.message.serialize();

  // Sign with both accounts
  const feePayerSignature = await signWithNearChainSignatures(
    serializedMessage,
    undefined,
  );
  const userAgentSignature = await signWithNearChainSignatures(
    serializedMessage,
    intent.userDestination,
  );

  const finalized = attachMultipleSignaturesToVersionedTx(transaction, [
    { signature: feePayerSignature, index: 0 },
    { signature: userAgentSignature, index: 1 },
  ]);
  const txId = await broadcastSolanaTx(finalized);

  console.log(`[kaminoWithdraw] Bridge transfer tx confirmed: ${txId}`);

  return { txId, depositAddress };
}
