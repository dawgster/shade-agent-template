import nacl from "tweetnacl";
import bs58 from "bs58";
import { UserSignature } from "../queue/types";

/**
 * Parses a NEAR public key string (e.g., "ed25519:ABC...") into raw bytes
 */
function parseNearPublicKey(publicKey: string): Uint8Array {
  const [keyType, keyData] = publicKey.split(":");

  if (keyType !== "ed25519") {
    throw new Error(`Unsupported key type: ${keyType}. Only ed25519 is supported.`);
  }

  if (!keyData) {
    throw new Error("Invalid public key format. Expected 'ed25519:<base58-key>'");
  }

  return bs58.decode(keyData);
}

/**
 * Decodes a signature from base64 or hex format
 */
function decodeSignature(signature: string): Uint8Array {
  // Try base64 first
  if (/^[A-Za-z0-9+/=]+$/.test(signature) && signature.length % 4 === 0) {
    try {
      const decoded = Buffer.from(signature, "base64");
      if (decoded.length === 64) {
        return new Uint8Array(decoded);
      }
    } catch {
      // Fall through to hex
    }
  }

  // Try hex
  if (/^(0x)?[0-9a-fA-F]+$/.test(signature)) {
    const hexStr = signature.startsWith("0x") ? signature.slice(2) : signature;
    if (hexStr.length === 128) {
      return new Uint8Array(Buffer.from(hexStr, "hex"));
    }
  }

  throw new Error("Invalid signature format. Expected base64 or hex-encoded 64-byte signature.");
}

/**
 * Decodes a message from hex format to bytes
 */
function decodeMessage(message: string): Uint8Array {
  const hexStr = message.startsWith("0x") ? message.slice(2) : message;
  return new Uint8Array(Buffer.from(hexStr, "hex"));
}

/**
 * Verifies a NEAR Ed25519 signature
 * @param userSignature - The signature object containing message, signature, and public key
 * @returns true if the signature is valid, false otherwise
 */
export function verifyNearSignature(userSignature: UserSignature): boolean {
  try {
    const publicKeyBytes = parseNearPublicKey(userSignature.publicKey);
    const signatureBytes = decodeSignature(userSignature.signature);
    const messageBytes = decodeMessage(userSignature.message);

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}

/**
 * Verifies that the signature's public key matches the expected public key
 * @param userSignature - The signature object
 * @param expectedPublicKey - The expected NEAR public key
 * @returns true if keys match, false otherwise
 */
export function verifyPublicKeyMatch(
  userSignature: UserSignature,
  expectedPublicKey: string,
): boolean {
  // Normalize both keys for comparison
  const normalizeKey = (key: string) => {
    if (key.startsWith("ed25519:")) {
      return key;
    }
    return `ed25519:${key}`;
  };

  return normalizeKey(userSignature.publicKey) === normalizeKey(expectedPublicKey);
}

/**
 * Creates the canonical message to sign for an intent
 * This ensures the user is signing a specific intent and not a generic message
 */
export function createIntentSigningMessage(intent: {
  intentId: string;
  sourceAmount: string;
  destinationAmount?: string;
  finalAsset: string;
  userDestination: string;
  metadata?: { action?: string } & Record<string, unknown>;
}): string {
  // Create a deterministic message that includes all critical intent fields
  const message = JSON.stringify({
    intentId: intent.intentId,
    sourceAmount: intent.sourceAmount,
    destinationAmount: intent.destinationAmount,
    finalAsset: intent.finalAsset,
    userDestination: intent.userDestination,
    action: intent.metadata?.action,
  });

  // Return SHA-256 hash as hex string
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(message).digest("hex");
  return hash;
}

/**
 * Validates a user signature for an intent
 * @param userSignature - The signature to validate
 * @param expectedPublicKey - The NEAR public key that should have signed
 * @param expectedMessage - The expected message hash (optional, for additional validation)
 * @returns An object with isValid and optional error message
 */
export function validateIntentSignature(
  userSignature: UserSignature,
  expectedPublicKey: string,
  expectedMessage?: string,
): { isValid: boolean; error?: string } {
  // Check public key matches
  if (!verifyPublicKeyMatch(userSignature, expectedPublicKey)) {
    return {
      isValid: false,
      error: `Public key mismatch. Expected ${expectedPublicKey}, got ${userSignature.publicKey}`,
    };
  }

  // Check message matches if provided
  if (expectedMessage && userSignature.message !== expectedMessage) {
    return {
      isValid: false,
      error: "Message mismatch. The signed message does not match the intent.",
    };
  }

  // Verify cryptographic signature
  if (!verifyNearSignature(userSignature)) {
    return {
      isValid: false,
      error: "Invalid signature. Cryptographic verification failed.",
    };
  }

  return { isValid: true };
}
