export type IntentChain = "near" | "solana" | "zcash" | "ethereum" | "arbitrum" | "base" | "optimism" | "aurora" | "polygon" | "bnb" | "avalanche";

export interface KaminoDepositMetadata extends Record<string, unknown> {
  action: "kamino-deposit";
  marketAddress: string;
  mintAddress: string;
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
  destinationAmount?: string;
  finalAsset: string;
  slippageBps?: number;
  userDestination: string;
  agentDestination: string;
  depositMemo?: string;
  originTxHash?: string;
  sessionId?: string;
  metadata?: IntentMetadata;
}

export interface UserSignature {
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base64 or hex format */
  signature: string;
  /** The NEAR public key that signed (e.g., "ed25519:ABC...") */
  publicKey: string;
}

export interface ValidatedIntent extends IntentMessage {
  slippageBps: number;
  nearPublicKey?: string;
  /** User signature proving authorization for this intent */
  userSignature?: UserSignature;
}
