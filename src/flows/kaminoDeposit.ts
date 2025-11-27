import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import {
  VersionedTransaction,
  Connection,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import {
  createSolanaRpc,
  address,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase64Encoder,
  compileTransaction,
  getCompiledTransactionMessageEncoder,
} from "@solana/kit";
import {
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import BN from "bn.js";
import { config } from "../config";
import { KaminoDepositMetadata, ValidatedIntent } from "../queue/types";
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
import {
  OneClickService,
  OpenAPI,
} from "@defuse-protocol/one-click-sdk-typescript";
import { getDefuseAssetId, getSolDefuseAssetId } from "../utils/tokenMappings";
import { SOL_NATIVE_MINT } from "../constants";
import { getTokenBalance, waitForTokenBalance } from "../utils/solanaBalance";
import { setStatus } from "../state/status";

const { uint8ArrayToHex } = utils.cryptography;

// How long to wait for intents to deliver tokens (15 minutes)
const INTENTS_TIMEOUT_MS = 15 * 60 * 1000;
// How often to poll for token balance
const BALANCE_POLL_INTERVAL_MS = 10_000;

interface KaminoDepositResult {
  txId: string;
  /** If intents was used, contains the deposit address used */
  intentsDepositAddress?: string;
  /** Amount received after intents swap (before Kamino deposit) */
  swappedAmount?: string;
}

export function isKaminoDepositIntent(
  intent: ValidatedIntent,
): intent is ValidatedIntent & { metadata: KaminoDepositMetadata } {
  const meta = intent.metadata as KaminoDepositMetadata | undefined;
  return meta?.action === "kamino-deposit" && !!meta.marketAddress && !!meta.mintAddress;
}

function createKaminoRpc() {
  return createSolanaRpc(config.solRpcUrl);
}

/**
 * Verifies that the intent has a valid user signature authorizing the action
 * Throws an error if authorization fails
 */
function verifyUserAuthorization(intent: ValidatedIntent): void {
  // Require nearPublicKey for Kamino deposits
  if (!intent.nearPublicKey) {
    throw new Error("Kamino deposit requires nearPublicKey to identify the user");
  }

  // Require user signature
  if (!intent.userSignature) {
    throw new Error("Kamino deposit requires userSignature for authorization");
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

export async function executeKaminoDepositFlow(
  intent: ValidatedIntent,
): Promise<KaminoDepositResult> {
  // Verify user authorization via signature
  verifyUserAuthorization(intent);

  const meta = intent.metadata as KaminoDepositMetadata;

  if (config.dryRunSwaps) {
    const result: KaminoDepositResult = { txId: `dry-run-kamino-${intent.intentId}` };
    if (meta.useIntents) {
      result.intentsDepositAddress = "dry-run-deposit-address";
      result.swappedAmount = intent.sourceAmount;
    }
    return result;
  }

  // Get the agent's Solana address
  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );
  const agentSolanaAddress = agentPublicKey.toBase58();

  let depositAmount = intent.sourceAmount;
  let intentsDepositAddress: string | undefined;
  let depositMemo: string | undefined;

  if (meta.useIntents) {
    console.log(`[kaminoDeposit] Using Intents to swap ${intent.sourceAsset} to pool target asset`);

    // Step 1: Get the intents quote and deposit address
    const intentsResult = await executeIntentsSwap(intent, meta);
    intentsDepositAddress = intentsResult.depositAddress;
    depositMemo = intentsResult.depositMemo;
    const expectedAmount = BigInt(intentsResult.expectedAmount);

    console.log(`[kaminoDeposit] Got intents deposit address: ${intentsDepositAddress}`);
    console.log(`[kaminoDeposit] Expected amount after swap: ${expectedAmount}`);

    // Step 2: Update status to awaiting_deposit so the user knows where to send funds
    await setStatus(intent.intentId, {
      state: "awaiting_deposit",
      depositAddress: intentsDepositAddress,
      depositMemo,
      expectedAmount: intentsResult.expectedAmount,
    });

    // Step 3: Get the current balance before the swap
    const balanceBefore = await getTokenBalance(agentSolanaAddress, meta.mintAddress);
    console.log(`[kaminoDeposit] Balance before: ${balanceBefore}`);

    // Step 4: Wait for intents to deliver the tokens
    // The user deposits to the intents address, intents swaps and delivers to agent's Solana address
    await setStatus(intent.intentId, {
      state: "awaiting_intents",
      detail: "Waiting for cross-chain swap to complete",
    });

    console.log(`[kaminoDeposit] Waiting for tokens to arrive at ${agentSolanaAddress}...`);

    // Wait for balance to increase by at least the expected amount (with some tolerance for slippage)
    const minExpectedBalance = balanceBefore + (expectedAmount * BigInt(97)) / BigInt(100); // Allow 3% slippage

    const actualBalance = await waitForTokenBalance(
      agentSolanaAddress,
      meta.mintAddress,
      minExpectedBalance,
      INTENTS_TIMEOUT_MS,
      BALANCE_POLL_INTERVAL_MS,
    );

    // Calculate the actual received amount
    const receivedAmount = actualBalance - balanceBefore;
    depositAmount = receivedAmount.toString();

    console.log(`[kaminoDeposit] Tokens received! Amount: ${receivedAmount}`);

    // Step 5: Update status to processing for the Kamino deposit
    await setStatus(intent.intentId, {
      state: "processing",
      detail: "Executing Kamino deposit",
    });
  }

  // Execute the Kamino deposit with the received tokens
  console.log(`[kaminoDeposit] Building Kamino deposit transaction for amount: ${depositAmount}`);

  const { transaction, serializedMessage } = await buildKaminoDepositTransaction(
    intent,
    depositAmount,
  );
  const signature = await signWithNearChainSignatures(
    serializedMessage,
    intent.nearPublicKey,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  const txId = await broadcastSolanaTx(finalized);

  console.log(`[kaminoDeposit] Kamino deposit confirmed: ${txId}`);

  return {
    txId,
    intentsDepositAddress,
    swappedAmount: depositAmount,
  };
}

interface IntentsSwapResult {
  depositAddress: string;
  depositMemo?: string;
  expectedAmount: string;
}

/**
 * Executes the Intents swap to convert the source asset to the Kamino pool's target asset.
 * Returns the deposit address where the user should send their funds.
 */
async function executeIntentsSwap(
  intent: ValidatedIntent,
  meta: KaminoDepositMetadata,
): Promise<IntentsSwapResult> {
  if (config.intentsQuoteUrl) {
    OpenAPI.BASE = config.intentsQuoteUrl;
  }

  // Get the agent's Solana address where intents will deliver the swapped tokens
  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );
  const agentSolanaAddress = agentPublicKey.toBase58();

  // Convert the target mint address to Defuse asset ID
  const destinationAsset =
    meta.mintAddress === SOL_NATIVE_MINT
      ? getSolDefuseAssetId()
      : getDefuseAssetId("solana", meta.mintAddress) || `nep141:${meta.mintAddress}.omft.near`;

  // The origin asset should be provided by the caller in Defuse format
  const originAsset = intent.sourceAsset;

  // Create deadline 30 minutes from now
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const quoteRequest = {
    originAsset,
    destinationAsset,
    amount: String(intent.sourceAmount),
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: meta.slippageTolerance ?? 300, // Default 3%
    dry: false, // We need the deposit address
    recipient: agentSolanaAddress,
    recipientType: "DESTINATION_CHAIN" as const,
    refundTo: intent.nearPublicKey || intent.userDestination,
    refundType: "ORIGIN_CHAIN" as const,
    depositType: "ORIGIN_CHAIN" as const,
    deadline,
  };

  console.log("[kaminoDeposit] Requesting intents quote", quoteRequest);

  const quoteResponse = await OneClickService.getQuote(quoteRequest as any);
  const quote = quoteResponse as any;

  const depositAddress = quote.depositAddress;
  if (!depositAddress) {
    throw new Error("Intents quote response missing depositAddress");
  }

  const depositMemo = quote.depositMemo;
  const expectedAmount =
    quote.amountOut || quote.minAmountOut || quote.quote?.amountOut || intent.sourceAmount;

  console.log(`[kaminoDeposit] Got intents deposit address: ${depositAddress}, memo: ${depositMemo}, expected: ${expectedAmount}`);

  return {
    depositAddress,
    depositMemo,
    expectedAmount: String(expectedAmount),
  };
}

async function buildKaminoDepositTransaction(
  intent: ValidatedIntent,
  depositAmount: string,
): Promise<{ transaction: VersionedTransaction; serializedMessage: Uint8Array }> {
  const rpc = createKaminoRpc();
  const meta = intent.metadata as KaminoDepositMetadata;

  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.nearPublicKey,
  );
  const ownerAddress = address(agentPublicKey.toBase58());

  // Create a dummy signer - we only need its address, not actual signing capability
  // The actual signing is done via NEAR chain signatures
  const dummySigner = await createDummySigner(ownerAddress);

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

  const amount = new BN(depositAmount);

  const depositAction = await KaminoAction.buildDepositTxns(
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
    ...depositAction.computeBudgetIxs,
    ...depositAction.setupIxs,
    ...depositAction.lendingIxs,
    ...depositAction.cleanupIxs,
  ];

  // Get recent blockhash using kit RPC
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // Compile the transaction message using @solana/kit
  const transactionMessage = {
    version: 0 as const,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 0,
    },
    staticAccounts: [] as string[],
    lifetimeToken: latestBlockhash.blockhash,
    instructions,
    addressTableLookups: [],
  };

  const compiledTx = compileTransaction(transactionMessage as any);
  const encoder = getCompiledTransactionMessageEncoder();
  const serializedMessage = encoder.encode(compiledTx.messageBytes as any);

  // For broadcasting via @solana/web3.js, we need to convert the transaction
  // Re-fetch the blockhash and build with web3.js types for compatibility
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

async function createDummySigner(ownerAddress: string) {
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
