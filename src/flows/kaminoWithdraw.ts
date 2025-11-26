import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import {
  VersionedTransaction,
  Connection,
  TransactionMessage,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
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
  broadcastSolanaTx,
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
} from "../utils/solana";
import { parseSignature } from "../utils/signature";
import {
  createIntentSigningMessage,
  validateIntentSignature,
} from "../utils/nearSignature";
import { SOL_NATIVE_MINT } from "../constants";
import {
  OneClickService,
  OpenAPI,
} from "@defuse-protocol/one-click-sdk-typescript";

const { uint8ArrayToHex } = utils.cryptography;

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
  // Require nearPublicKey for Kamino withdrawals
  if (!intent.nearPublicKey) {
    throw new Error("Kamino withdraw requires nearPublicKey to identify the user");
  }

  // Require user signature
  if (!intent.userSignature) {
    throw new Error("Kamino withdraw requires userSignature for authorization");
  }

  // Generate the expected message hash for this intent
  const expectedMessage = createIntentSigningMessage(intent);

  // Validate the signature
  const result = validateIntentSignature(
    intent.userSignature,
    intent.nearPublicKey,
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
  const signature = await signWithNearChainSignatures(
    serializedMessage,
    intent.nearPublicKey,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
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

  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );
  const ownerAddress = address(agentPublicKey.toBase58());

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
  const web3Instructions = instructions.map((ix: any) => ({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((acc: any) => ({
      pubkey: new PublicKey(acc.address),
      isSigner: acc.role === 3 || acc.role === 2, // SIGNER or SIGNER_WRITABLE
      isWritable: acc.role === 1 || acc.role === 3, // WRITABLE or SIGNER_WRITABLE
    })),
    data: Buffer.from(ix.data),
  }));

  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions: web3Instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  return { transaction, serializedMessage: transaction.message.serialize() };
}

function createDummySigner(ownerAddress: string) {
  // Create a minimal signer interface that only provides the address
  // The actual signing happens via NEAR chain signatures
  return {
    address: ownerAddress,
    signTransactions: async () => {
      throw new Error("Signing handled by NEAR chain signatures");
    },
    signMessages: async () => {
      throw new Error("Signing handled by NEAR chain signatures");
    },
  } as any;
}

async function signWithNearChainSignatures(
  payloadBytes: Uint8Array,
  nearPublicKey?: string,
): Promise<Uint8Array> {
  if (!config.shadeContractId) {
    throw new Error("NEXT_PUBLIC_contractId not configured for signing");
  }

  const derivationPath = nearPublicKey
    ? `${SOLANA_DEFAULT_PATH},${nearPublicKey}`
    : SOLANA_DEFAULT_PATH;

  const payload = uint8ArrayToHex(payloadBytes);
  const signRes = await requestSignature({
    path: derivationPath,
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

  const originAsset = `sol:${mintAddress}`;
  const quoteRequest = {
    originAsset,
    destinationAsset,
    amount: withdrawnAmount,
    slippageTolerance: slippageTolerance ?? 300, // Default 3%
    dry: false, // Important: we need the deposit address
    recipient: destinationAddress,
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
  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );

  const connection = new Connection(config.solRpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();

  let transferIx;
  const depositPubkey = new PublicKey(depositAddress);

  // Check if this is native SOL or an SPL token
  if (mintAddress === SOL_NATIVE_MINT) {
    // Native SOL transfer
    transferIx = SystemProgram.transfer({
      fromPubkey: agentPublicKey,
      toPubkey: depositPubkey,
      lamports: BigInt(withdrawnAmount),
    });
  } else {
    // SPL token transfer
    const mintPubkey = new PublicKey(mintAddress);

    // Get or create associated token accounts
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey,
      agentPublicKey,
    );

    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey,
      depositPubkey,
      true, // allowOwnerOffCurve for PDA
    );

    // Check if destination ATA exists
    const destinationAtaInfo = await connection.getAccountInfo(destinationAta);

    const instructions = [];

    // Create destination ATA if it doesn't exist
    if (!destinationAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          agentPublicKey, // payer
          destinationAta, // ata
          depositPubkey, // owner
          mintPubkey, // mint
        ),
      );
    }

    // Add transfer instruction
    instructions.push(
      createTransferInstruction(
        sourceAta,
        destinationAta,
        agentPublicKey,
        BigInt(withdrawnAmount),
      ),
    );

    // Build transaction with multiple instructions
    const messageV0 = new TransactionMessage({
      payerKey: agentPublicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    // Sign and broadcast
    const signature = await signWithNearChainSignatures(
      transaction.message.serialize(),
      intent.nearPublicKey,
    );
    const finalized = attachSignatureToVersionedTx(transaction, signature);
    const txId = await broadcastSolanaTx(finalized);

    console.log(`[kaminoWithdraw] Bridge transfer tx confirmed: ${txId}`);

    return { txId, depositAddress };
  }

  // For native SOL, build a simple transfer transaction
  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions: [transferIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  // Sign and broadcast
  const signature = await signWithNearChainSignatures(
    transaction.message.serialize(),
    intent.nearPublicKey,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  const txId = await broadcastSolanaTx(finalized);

  console.log(`[kaminoWithdraw] Bridge transfer tx confirmed: ${txId}`);

  return { txId, depositAddress };
}
