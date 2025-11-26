export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";

/**
 * Extracts the Solana mint address from various asset ID formats.
 * Supports:
 * - 1cs_v1:sol:spl:<mintAddress> (1-Click SDK format for SPL tokens)
 * - 1cs_v1:sol:spl:<mintAddress>:<decimals> (1-Click SDK format with decimals)
 * - sol:<mintAddress> (simple chain prefix format)
 * - Raw mint addresses (44-character base58 strings)
 *
 * @param assetId The asset ID in any supported format
 * @returns The raw Solana mint address, or the original string if no pattern matches
 */
export function extractSolanaMintAddress(assetId: string): string {
  if (!assetId) return assetId;

  // 1cs_v1:sol:spl:<mintAddress> or 1cs_v1:sol:spl:<mintAddress>:<decimals>
  if (assetId.startsWith("1cs_v1:sol:spl:")) {
    const parts = assetId.split(":");
    // parts[0] = "1cs_v1", parts[1] = "sol", parts[2] = "spl", parts[3] = mintAddress, parts[4]? = decimals
    if (parts.length >= 4 && parts[3]) {
      return parts[3];
    }
  }

  // sol:<mintAddress> format
  if (assetId.startsWith("sol:")) {
    return assetId.slice(4);
  }

  // Already a raw mint address (44-character base58)
  // Solana addresses are 32-44 characters in base58
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(assetId)) {
    return assetId;
  }

  // Return as-is for unrecognized formats
  return assetId;
}
