import { config } from "../config";
import { BurrowWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  getAssetsPagedDetailed,
  buildWithdrawTransaction,
} from "../utils/burrow";
import {
  createIntentSigningMessage,
  validateIntentSignature,
} from "../utils/nearSignature";
import {
  executeMetaTransaction,
  createFunctionCallAction,
  GAS_FOR_FT_TRANSFER_CALL,
  ZERO_DEPOSIT,
} from "../utils/nearMetaTx";

interface BurrowWithdrawResult {
  txId: string;
  bridgeTxId?: string;
  intentsDepositAddress?: string;
}

export function isBurrowWithdrawIntent(
  intent: ValidatedIntent,
): intent is ValidatedIntent & { metadata: BurrowWithdrawMetadata } {
  const meta = intent.metadata as BurrowWithdrawMetadata | undefined;
  return meta?.action === "burrow-withdraw" && !!meta.tokenId;
}

function verifyUserAuthorization(intent: ValidatedIntent): void {
  if (!intent.nearPublicKey) {
    throw new Error("Burrow withdraw requires nearPublicKey to identify the user");
  }

  if (!intent.userSignature) {
    throw new Error("Burrow withdraw requires userSignature for authorization");
  }

  const expectedMessage = createIntentSigningMessage(intent);

  const result = validateIntentSignature(
    intent.userSignature,
    intent.nearPublicKey,
    expectedMessage,
  );

  if (!result.isValid) {
    throw new Error(`Authorization failed: ${result.error}`);
  }
}

export async function executeBurrowWithdrawFlow(
  intent: ValidatedIntent,
): Promise<BurrowWithdrawResult> {
  verifyUserAuthorization(intent);

  const meta = intent.metadata as BurrowWithdrawMetadata;

  if (config.dryRunSwaps) {
    const result: BurrowWithdrawResult = { txId: `dry-run-burrow-withdraw-${intent.intentId}` };
    if (meta.bridgeBack) {
      result.bridgeTxId = `dry-run-bridge-${intent.intentId}`;
      result.intentsDepositAddress = "dry-run-deposit-address";
    }
    return result;
  }

  if (!intent.userDestination) {
    throw new Error("Burrow withdraw requires userDestination for custody isolation");
  }

  // Verify the token can be withdrawn
  const assets = await getAssetsPagedDetailed();
  const asset = assets.find((a) => a.token_id === meta.tokenId);

  if (!asset) {
    throw new Error(`Token ${meta.tokenId} is not supported by Burrow`);
  }

  if (!asset.config.can_withdraw) {
    throw new Error(`Token ${meta.tokenId} cannot be withdrawn from Burrow`);
  }

  const withdrawAmount = intent.sourceAmount;

  // Build the withdraw transaction using Rhea SDK
  const withdrawTx = await buildWithdrawTransaction({
    token_id: meta.tokenId,
    amount: withdrawAmount,
  });

  console.log(`[burrowWithdraw] Built withdraw tx via Rhea SDK: ${withdrawTx.method_name} on ${withdrawTx.contract_id}`);

  // Create action for meta transaction
  const action = createFunctionCallAction(
    withdrawTx.method_name,
    withdrawTx.args,
    GAS_FOR_FT_TRANSFER_CALL,
    ZERO_DEPOSIT,
  );

  // Execute via meta transaction - agent pays for gas
  const txHash = await executeMetaTransaction(
    intent.userDestination,
    withdrawTx.contract_id,
    [action],
  );

  console.log(`[burrowWithdraw] Withdraw tx confirmed: ${txHash}`);

  // TODO: Implement bridgeBack if configured
  // Similar to Kamino, would:
  // 1. Get intents quote for bridging to destination chain
  // 2. Call ft_transfer_call to send tokens to intents deposit address
  // 3. Return bridge tx hash

  return { txId: txHash };
}
