import { chainAdapters, contracts } from "chainsig.js";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";

export const SOLANA_DEFAULT_PATH = "solana-1";

const chainSignatureContract = new contracts.ChainSignatureContract({
  networkId: config.chainSignatureNetwork as "mainnet" | "testnet",
  contractId: config.chainSignatureContractId,
  // Provided by backend even though typings omit it
  masterPublicKey: config.chainSignatureMpcKey,
  fallbackRpcUrls: config.nearRpcUrls,
} as any);

const solanaConnection = new Connection(config.solRpcUrl, "confirmed");

export const SolanaAdapter = new chainAdapters.solana.Solana({
  solanaConnection,
  contract: chainSignatureContract,
}) as any;

export function getSolanaConnection() {
  return solanaConnection;
}

export async function deriveAgentPublicKey(
  path = SOLANA_DEFAULT_PATH,
  userDestination?: string,
) {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  // Build derivation path including user destination for custody isolation
  // Each unique userDestination gets their own derived agent account
  let derivationPath = path;
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  const { publicKey } = await SolanaAdapter.deriveAddressAndPublicKey(
    accountId,
    derivationPath,
  );
  return new PublicKey(publicKey as string);
}

export function attachSignatureToVersionedTx(
  tx: VersionedTransaction,
  signature: Uint8Array,
): VersionedTransaction {
  const signatures = tx.signatures.length
    ? tx.signatures
    : Array(tx.message.header.numRequiredSignatures).fill(
        new Uint8Array(64),
      );
  signatures[0] = signature;
  const signed = new VersionedTransaction(tx.message, signatures);
  return signed;
}

/**
 * Attach multiple signatures to a versioned transaction at specified indices.
 * Used when a transaction requires multiple signers (e.g., fee payer + token owner).
 * @param tx - The transaction to sign
 * @param signaturePairs - Array of {signature, index} pairs matching signer order in the message
 */
export function attachMultipleSignaturesToVersionedTx(
  tx: VersionedTransaction,
  signaturePairs: Array<{ signature: Uint8Array; index: number }>,
): VersionedTransaction {
  const signatures = tx.signatures.length
    ? [...tx.signatures]
    : Array(tx.message.header.numRequiredSignatures).fill(
        new Uint8Array(64),
      );

  for (const { signature, index } of signaturePairs) {
    signatures[index] = signature;
  }

  return new VersionedTransaction(tx.message, signatures);
}

export async function broadcastSolanaTx(tx: VersionedTransaction, skipConfirmation = false) {
  const connection = getSolanaConnection();
  const sig = await connection.sendRawTransaction(tx.serialize());

  if (!skipConfirmation) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  return sig;
}
