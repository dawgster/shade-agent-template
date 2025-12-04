import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import {
  verifyNearSignature,
  verifyPublicKeyMatch,
  createIntentSigningMessage,
  validateIntentSignature,
} from "./nearSignature";
import { NearUserSignature, LegacyUserSignature } from "../queue/types";

// Generate a test keypair
const testKeypair = nacl.sign.keyPair();
const testPublicKeyBase58 = bs58.encode(testKeypair.publicKey);
const testPublicKeyNear = `ed25519:${testPublicKeyBase58}`;

// NEP-413 constants
const NEP413_TAG = 2147484061; // 2^31 + 413
const TEST_RECIPIENT = "shade-agent";

/**
 * Borsh-serializes a NEP-413 payload (mirrors the implementation in nearSignature.ts)
 */
function serializeNEP413Payload(
  tag: number,
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl?: string,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Serialize tag as u32 (little-endian)
  const tagBytes = new Uint8Array(4);
  tagBytes[0] = tag & 0xff;
  tagBytes[1] = (tag >> 8) & 0xff;
  tagBytes[2] = (tag >> 16) & 0xff;
  tagBytes[3] = (tag >> 24) & 0xff;
  parts.push(tagBytes);

  // Serialize message as string
  const messageBytes = Buffer.from(message, "utf-8");
  const messageLenBytes = new Uint8Array(4);
  messageLenBytes[0] = messageBytes.length & 0xff;
  messageLenBytes[1] = (messageBytes.length >> 8) & 0xff;
  messageLenBytes[2] = (messageBytes.length >> 16) & 0xff;
  messageLenBytes[3] = (messageBytes.length >> 24) & 0xff;
  parts.push(messageLenBytes);
  parts.push(new Uint8Array(messageBytes));

  // Serialize nonce as [u8; 32]
  parts.push(nonce);

  // Serialize recipient as string
  const recipientBytes = Buffer.from(recipient, "utf-8");
  const recipientLenBytes = new Uint8Array(4);
  recipientLenBytes[0] = recipientBytes.length & 0xff;
  recipientLenBytes[1] = (recipientBytes.length >> 8) & 0xff;
  recipientLenBytes[2] = (recipientBytes.length >> 16) & 0xff;
  recipientLenBytes[3] = (recipientBytes.length >> 24) & 0xff;
  parts.push(recipientLenBytes);
  parts.push(new Uint8Array(recipientBytes));

  // Serialize callbackUrl as Option<string>
  if (callbackUrl !== undefined) {
    parts.push(new Uint8Array([1]));
    const callbackBytes = Buffer.from(callbackUrl, "utf-8");
    const callbackLenBytes = new Uint8Array(4);
    callbackLenBytes[0] = callbackBytes.length & 0xff;
    callbackLenBytes[1] = (callbackBytes.length >> 8) & 0xff;
    callbackLenBytes[2] = (callbackBytes.length >> 16) & 0xff;
    callbackLenBytes[3] = (callbackBytes.length >> 24) & 0xff;
    parts.push(callbackLenBytes);
    parts.push(new Uint8Array(callbackBytes));
  } else {
    parts.push(new Uint8Array([0]));
  }

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Signs a message using NEP-413 format (simulates what the NEAR wallet does)
 */
function signMessageNEP413(
  message: string,
  nonce: Uint8Array,
  recipient: string,
): { signature: string; nonce: string } {
  // Serialize the NEP-413 payload
  const serialized = serializeNEP413Payload(NEP413_TAG, message, nonce, recipient);

  // SHA-256 hash the serialized payload
  const hash = crypto.createHash("sha256").update(serialized).digest();

  // Sign the hash
  const signature = nacl.sign.detached(new Uint8Array(hash), testKeypair.secretKey);

  return {
    signature: Buffer.from(signature).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
  };
}

/**
 * Creates a full LegacyUserSignature for testing (NEAR NEP-413 format)
 */
function createTestUserSignature(message: string): LegacyUserSignature {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);

  const { signature, nonce: nonceBase64 } = signMessageNEP413(message, nonce, TEST_RECIPIENT);

  return {
    message,
    signature,
    publicKey: testPublicKeyNear,
    nonce: nonceBase64,
    recipient: TEST_RECIPIENT,
  };
}

describe("nearSignature", () => {
  describe("verifyNearSignature (NEP-413)", () => {
    it("verifies a valid NEP-413 signature", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      // Corrupt the signature
      userSignature.signature = Buffer.from(new Uint8Array(64)).toString("base64");

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(false);
    });

    it("rejects signature from wrong key", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      // Use a different public key
      const otherKeypair = nacl.sign.keyPair();
      userSignature.publicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(false);
    });

    it("rejects signature with wrong nonce", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      // Change the nonce (verification should fail because the hash will differ)
      const wrongNonce = new Uint8Array(32);
      crypto.getRandomValues(wrongNonce);
      userSignature.nonce = Buffer.from(wrongNonce).toString("base64");

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(false);
    });

    it("rejects signature with wrong recipient", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      // Change the recipient
      userSignature.recipient = "wrong-recipient";

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(false);
    });

    it("rejects signature with wrong message", () => {
      const userSignature = createTestUserSignature("original-message");

      // Change the message
      userSignature.message = "different-message";

      const result = verifyNearSignature(userSignature);

      expect(result).toBe(false);
    });

    it("handles hex-encoded signatures", () => {
      const message = "deadbeef";
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);

      const serialized = serializeNEP413Payload(NEP413_TAG, message, nonce, TEST_RECIPIENT);
      const hash = crypto.createHash("sha256").update(serialized).digest();
      const signatureBytes = nacl.sign.detached(new Uint8Array(hash), testKeypair.secretKey);
      const signatureHex = Buffer.from(signatureBytes).toString("hex");

      const result = verifyNearSignature({
        message,
        signature: signatureHex,
        publicKey: testPublicKeyNear,
        nonce: Buffer.from(nonce).toString("base64"),
        recipient: TEST_RECIPIENT,
      });

      expect(result).toBe(true);
    });
  });

  describe("verifyPublicKeyMatch", () => {
    it("matches identical keys", () => {
      const result = verifyPublicKeyMatch(
        createTestUserSignature("test"),
        testPublicKeyNear,
      );
      expect(result).toBe(true);
    });

    it("matches keys with/without ed25519 prefix", () => {
      const userSig = createTestUserSignature("test");
      userSig.publicKey = testPublicKeyBase58; // Without prefix

      const result = verifyPublicKeyMatch(userSig, testPublicKeyNear);
      expect(result).toBe(true);
    });

    it("rejects different keys", () => {
      const otherKeypair = nacl.sign.keyPair();
      const otherPublicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const result = verifyPublicKeyMatch(
        createTestUserSignature("test"),
        otherPublicKey,
      );
      expect(result).toBe(false);
    });
  });

  describe("createIntentSigningMessage", () => {
    it("creates a deterministic hash", () => {
      const intent = {
        intentId: "test-123",
        sourceAmount: "1000000",
        destinationAmount: "500000",
        finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
        metadata: { action: "kamino-deposit" },
      };

      const hash1 = createIntentSigningMessage(intent);
      const hash2 = createIntentSigningMessage(intent);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different hashes for different intents", () => {
      const intent1 = {
        intentId: "test-123",
        sourceAmount: "1000000",
        finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
      };

      const intent2 = {
        ...intent1,
        sourceAmount: "2000000",
      };

      const hash1 = createIntentSigningMessage(intent1);
      const hash2 = createIntentSigningMessage(intent2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("validateIntentSignature", () => {
    it("validates a correct signature", () => {
      const intent = {
        intentId: "test-123",
        sourceAmount: "1000000",
        finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
      };

      const expectedMessage = createIntentSigningMessage(intent);
      const userSignature = createTestUserSignature(expectedMessage);

      const result = validateIntentSignature(
        userSignature,
        testPublicKeyNear,
        expectedMessage,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects missing nonce", () => {
      const userSignature = createTestUserSignature("test") as Partial<LegacyUserSignature>;
      delete userSignature.nonce;

      const result = validateIntentSignature(
        userSignature as LegacyUserSignature,
        testPublicKeyNear,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Not a NEAR NEP-413 signature");
    });

    it("rejects missing recipient", () => {
      const userSignature = createTestUserSignature("test") as Partial<LegacyUserSignature>;
      delete userSignature.recipient;

      const result = validateIntentSignature(
        userSignature as LegacyUserSignature,
        testPublicKeyNear,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Not a NEAR NEP-413 signature");
    });

    it("rejects mismatched public key", () => {
      const otherKeypair = nacl.sign.keyPair();
      const otherPublicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const userSignature = createTestUserSignature("deadbeef");

      const result = validateIntentSignature(
        userSignature,
        otherPublicKey,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Public key mismatch");
    });

    it("rejects mismatched message", () => {
      const userSignature = createTestUserSignature("wrongmessage");

      const result = validateIntentSignature(
        userSignature,
        testPublicKeyNear,
        "expectedmessage",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Message mismatch");
    });

    it("rejects invalid cryptographic signature", () => {
      const message = "deadbeef";
      const userSignature = createTestUserSignature(message);

      // Corrupt the signature
      userSignature.signature = Buffer.from(new Uint8Array(64)).toString("base64");

      const result = validateIntentSignature(
        userSignature,
        testPublicKeyNear,
        message,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Cryptographic verification failed");
    });
  });
});
