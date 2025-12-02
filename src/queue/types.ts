export type IntentChain = "near" | "solana" | "zcash" | "ethereum" | "arbitrum" | "base" | "optimism" | "aurora" | "polygon" | "bnb" | "avalanche";

export interface KaminoDepositMetadata extends Record<string, unknown> {
  action: "kamino-deposit";
  marketAddress: string;
  /** The raw Solana mint address of the underlying asset */
  mintAddress: string;
  /** The Defuse asset ID for the target asset (e.g., "1cs_v1:sol:spl:EPj...:6") */
  targetDefuseAssetId?: string;
  /** If true, use intents to bridge sourceAsset to the pool's target asset first */
  useIntents?: boolean;
  /** Slippage tolerance in basis points for the intents swap */
  slippageTolerance?: number;
}

export interface KaminoWithdrawMetadata extends Record<string, unknown> {
  action: "kamino-withdraw";
  marketAddress: string;
  mintAddress: string;
  /** Optional: bridge withdrawn tokens back to another chain via intents */
  bridgeBack?: {
    /** Destination chain for the bridge (e.g., "zcash") */
    destinationChain: string;
    /** User's address on the destination chain */
    destinationAddress: string;
    /** Destination asset identifier (e.g., "zec:zec") */
    destinationAsset: string;
    /** Optional slippage tolerance in basis points */
    slippageTolerance?: number;
  };
}

export type IntentMetadata =
  | KaminoDepositMetadata
  | KaminoWithdrawMetadata
  | Record<string, unknown>;

export interface IntentMessage {
  intentId: string;
  sourceChain: IntentChain;
  sourceAsset: string;
  sourceAmount: string;
  destinationChain: IntentChain;
  intermediateAsset?: string;
  /** Amount in intermediate asset units (e.g., lamports for SOL) after first-leg swap */
  intermediateAmount?: string;
  destinationAmount?: string;
  finalAsset: string;
  slippageBps?: number;
  userDestination: string;
  agentDestination: string;
  /** Intents deposit address for cross-chain swaps */
  intentsDepositAddress?: string;
  depositMemo?: string;
  originTxHash?: string;
  sessionId?: string;
  metadata?: IntentMetadata;
  /** NEAR public key for Kamino operations (derives Solana address) */
  nearPublicKey?: string;
  /** User's address on the source chain for refunds */
  refundAddress?: string;
  /** User signature proving authorization for this intent (required for withdrawals) */
  userSignature?: UserSignature;
}

export interface UserSignature {
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base64 or hex format */
  signature: string;
  /** The NEAR public key that signed (e.g., "ed25519:ABC...") */
  publicKey: string;
  /** The nonce used for NEP-413 signing (base64-encoded 32 bytes) */
  nonce: string;
  /** The recipient used for NEP-413 signing */
  recipient: string;
}

export interface ValidatedIntent extends IntentMessage {
  slippageBps: number;
}
