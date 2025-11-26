import { chainAdapters, contracts } from "chainsig.js";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";

export const SOLANA_DEFAULT_PATH = "solana-1";

const chainSignatureContract = new contracts.ChainSignatureContract({
  networkId: config.chainSignatureNetwork as "mainnet" | "testnet",
  contractId: config.chainSignatureContractId,
  // Provided by backend even though typings omit it
  masterPublicKey: config.chainSignatureMpcKey,
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
  nearPublicKey?: string,
) {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  const derivationPath = nearPublicKey ? `${path},${nearPublicKey}` : path;

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

export async function broadcastSolanaTx(tx: VersionedTransaction) {
  const connection = getSolanaConnection();
  const sig = await connection.sendRawTransaction(tx.serialize());
  return sig;
}
