import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import { VersionedTransaction } from "@solana/web3.js";
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

const { uint8ArrayToHex } = utils.cryptography;

interface KaminoDepositResult {
  txId: string;
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

  if (config.dryRunSwaps) {
    return { txId: `dry-run-kamino-${intent.intentId}` };
  }

  const { transaction, serializedMessage } = await buildKaminoDepositTransaction(intent);
  const signature = await signWithNearChainSignatures(
    serializedMessage,
    intent.nearPublicKey,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  const txId = await broadcastSolanaTx(finalized);

  return { txId };
}

async function buildKaminoDepositTransaction(
  intent: ValidatedIntent,
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

  const amount = new BN(intent.destinationAmount || intent.sourceAmount);

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
  const { Connection, TransactionMessage, PublicKey } = await import("@solana/web3.js");
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
