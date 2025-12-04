import { Account, connect, keyStores, KeyPair } from "near-api-js";
import { actionCreators, SignedDelegate, Action, encodeDelegateAction, buildDelegateAction } from "@near-js/transactions";
import { PublicKey, KeyType } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { Signature } from "@near-js/transactions";
import { config, isTestnet } from "../config";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "./chainSignature";
import { requestSignature, agentAccountId } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import { parseSeedPhrase } from "near-seed-phrase";
import crypto from "crypto";

const { uint8ArrayToHex } = utils.cryptography;

export const GAS_FOR_FT_TRANSFER_CALL = BigInt("100000000000000"); // 100 TGas
export const ONE_YOCTO = BigInt("1");
export const ZERO_DEPOSIT = BigInt("0");

const DELEGATE_ACTION_TTL = 120;

const networkId = isTestnet ? "testnet" : "mainnet";
const nodeUrl = config.nearRpcUrls[0] || (isTestnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org");

/**
 * Get the relayer account (agent's account that pays for gas)
 */
async function getRelayerAccount(): Promise<Account> {
  if (!config.nearSeedPhrase) {
    throw new Error("NEAR_SEED_PHRASE not configured");
  }

  const { accountId } = await agentAccountId();
  const { secretKey } = parseSeedPhrase(config.nearSeedPhrase);

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, KeyPair.fromString(secretKey as `ed25519:${string}`));

  const near = await connect({ networkId, keyStore, nodeUrl });
  return near.account(accountId);
}

/**
 * Build and sign a DelegateAction using chain signatures, then relay it
 */
export async function executeMetaTransaction(
  userDestination: string,
  receiverId: string,
  actions: Action[],
): Promise<string> {
  const provider = new JsonRpcProvider({ url: nodeUrl });

  // Derive the user's NEAR implicit account
  const { accountId: senderId, publicKey: publicKeyStr } = await deriveNearImplicitAccount(
    NEAR_DEFAULT_PATH,
    userDestination,
  );
  const publicKey = PublicKey.fromString(publicKeyStr);

  console.log(`[nearMetaTx] Building delegate action for ${senderId} -> ${receiverId}`);

  // Get nonce and block height
  let nonce = BigInt(0);
  try {
    const accessKey = await provider.query({
      request_type: "view_access_key",
      finality: "final",
      account_id: senderId,
      public_key: publicKeyStr,
    });
    nonce = BigInt((accessKey as any).nonce);
  } catch (e: any) {
    if (!e.message?.includes("does not exist")) throw e;
  }

  const block = await provider.block({ finality: "final" });
  const maxBlockHeight = BigInt(block.header.height) + BigInt(DELEGATE_ACTION_TTL);

  // Build the delegate action
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId,
    actions,
    nonce: nonce + 1n,
    maxBlockHeight,
    publicKey,
  });

  // Hash and sign with chain signatures
  const hash = crypto.createHash("sha256").update(encodeDelegateAction(delegateAction)).digest();
  const derivationPath = `${NEAR_DEFAULT_PATH},${userDestination}`;

  const signRes = await requestSignature({
    path: derivationPath,
    payload: uint8ArrayToHex(hash),
    keyType: "Eddsa",
  });

  if (!signRes.signature) {
    throw new Error("Failed to get signature from chain signatures");
  }

  // Parse signature
  let sigData: Uint8Array;
  if (typeof signRes.signature === "string") {
    sigData = signRes.signature.startsWith("0x")
      ? Buffer.from(signRes.signature.slice(2), "hex")
      : Buffer.from(signRes.signature, "hex");
  } else {
    sigData = new Uint8Array(64);
    sigData.set(Buffer.from(signRes.signature.r, "hex"), 0);
    sigData.set(Buffer.from(signRes.signature.s, "hex"), 32);
  }

  const signedDelegate = new SignedDelegate({
    delegateAction,
    signature: new Signature({ keyType: KeyType.ED25519, data: sigData }),
  });

  // Submit via relayer
  const relayer = await getRelayerAccount();
  console.log(`[nearMetaTx] Relaying via ${relayer.accountId}`);

  const result = await relayer.signAndSendTransaction({
    receiverId: senderId,
    actions: [actionCreators.signedDelegate(signedDelegate)],
  });

  const txHash = (result as any).transaction?.hash || (result as any).transaction_outcome?.id;
  console.log(`[nearMetaTx] Transaction: ${txHash}`);
  return txHash;
}

/**
 * Create a function call action
 */
export function createFunctionCallAction(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint = GAS_FOR_FT_TRANSFER_CALL,
  deposit: bigint = ZERO_DEPOSIT,
): Action {
  return actionCreators.functionCall(methodName, args, gas, deposit);
}
