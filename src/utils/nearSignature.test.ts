import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  verifyNearSignature,
  verifyPublicKeyMatch,
  createIntentSigningMessage,
  validateIntentSignature,
} from "./nearSignature";

// Generate a test keypair
const testKeypair = nacl.sign.keyPair();
const testPublicKeyBase58 = bs58.encode(testKeypair.publicKey);
const testPublicKeyNear = `ed25519:${testPublicKeyBase58}`;

function signMessage(message: string): string {
  const messageBytes = Buffer.from(message, "hex");
  const signature = nacl.sign.detached(messageBytes, testKeypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

describe("nearSignature", () => {
  describe("verifyNearSignature", () => {
    it("verifies a valid signature", () => {
      const message = "deadbeef";
      const signature = signMessage(message);

      const result = verifyNearSignature({
        message,
        signature,
        publicKey: testPublicKeyNear,
      });

      expect(result).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const message = "deadbeef";
      const wrongSignature = Buffer.from(new Uint8Array(64)).toString("base64");

      const result = verifyNearSignature({
        message,
        signature: wrongSignature,
        publicKey: testPublicKeyNear,
      });

      expect(result).toBe(false);
    });

    it("rejects signature from wrong key", () => {
      const message = "deadbeef";
      const signature = signMessage(message);

      // Generate a different keypair
      const otherKeypair = nacl.sign.keyPair();
      const otherPublicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const result = verifyNearSignature({
        message,
        signature,
        publicKey: otherPublicKey,
      });

      expect(result).toBe(false);
    });

    it("handles hex-encoded signatures", () => {
      const message = "deadbeef";
      const messageBytes = Buffer.from(message, "hex");
      const signatureBytes = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureHex = Buffer.from(signatureBytes).toString("hex");

      const result = verifyNearSignature({
        message,
        signature: signatureHex,
        publicKey: testPublicKeyNear,
      });

      expect(result).toBe(true);
    });
  });

  describe("verifyPublicKeyMatch", () => {
    it("matches identical keys", () => {
      const result = verifyPublicKeyMatch(
        { message: "", signature: "", publicKey: testPublicKeyNear },
        testPublicKeyNear,
      );
      expect(result).toBe(true);
    });

    it("matches keys with/without ed25519 prefix", () => {
      const result = verifyPublicKeyMatch(
        { message: "", signature: "", publicKey: testPublicKeyBase58 },
        testPublicKeyNear,
      );
      expect(result).toBe(true);
    });

    it("rejects different keys", () => {
      const otherKeypair = nacl.sign.keyPair();
      const otherPublicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const result = verifyPublicKeyMatch(
        { message: "", signature: "", publicKey: testPublicKeyNear },
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
      const signature = signMessage(expectedMessage);

      const result = validateIntentSignature(
        { message: expectedMessage, signature, publicKey: testPublicKeyNear },
        testPublicKeyNear,
        expectedMessage,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects mismatched public key", () => {
      const otherKeypair = nacl.sign.keyPair();
      const otherPublicKey = `ed25519:${bs58.encode(otherKeypair.publicKey)}`;

      const result = validateIntentSignature(
        { message: "deadbeef", signature: "sig", publicKey: testPublicKeyNear },
        otherPublicKey,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Public key mismatch");
    });

    it("rejects mismatched message", () => {
      const result = validateIntentSignature(
        { message: "wrongmessage", signature: "sig", publicKey: testPublicKeyNear },
        testPublicKeyNear,
        "expectedmessage",
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Message mismatch");
    });

    it("rejects invalid cryptographic signature", () => {
      const message = "deadbeef";
      const wrongSignature = Buffer.from(new Uint8Array(64)).toString("base64");

      const result = validateIntentSignature(
        { message, signature: wrongSignature, publicKey: testPublicKeyNear },
        testPublicKeyNear,
        message,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Cryptographic verification failed");
    });
  });
});
