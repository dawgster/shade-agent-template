import { Hono } from "hono";
import { createSolanaRpc, address } from "@solana/kit";
import { KaminoMarket, PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { config } from "../config";
import { deriveAgentPublicKey, SOLANA_DEFAULT_PATH } from "../utils/solana";

const app = new Hono();

function createKaminoRpc() {
  return createSolanaRpc(config.solRpcUrl);
}

interface PositionInfo {
  reserveAddress: string;
  mintAddress: string;
  symbol: string;
  depositedAmount: string;
  depositedAmountUsd: string;
  borrowedAmount: string;
  borrowedAmountUsd: string;
}

interface KaminoPositionsResponse {
  userAddress: string;
  marketAddress: string;
  obligations: {
    obligationAddress: string;
    deposits: PositionInfo[];
    borrows: PositionInfo[];
    totalDepositedUsd: string;
    totalBorrowedUsd: string;
    ltv: string;
    liquidationLtv: string;
  }[];
}

app.get("/:marketAddress", async (c) => {
  const marketAddress = c.req.param("marketAddress");
  const userDestination = c.req.query("userDestination");

  if (!marketAddress) {
    return c.json({ error: "marketAddress is required" }, 400);
  }

  if (!userDestination) {
    return c.json({ error: "userDestination is required" }, 400);
  }

  try {
    // Derive the user's Solana address using the same path as deposits
    // userDestination is the NEAR account ID (e.g., "user.near")
    console.log(`[kaminoPositions] Fetching positions for userDestination: ${userDestination}`);
    console.log(`[kaminoPositions] Using derivation path: ${SOLANA_DEFAULT_PATH},${userDestination}`);

    const userPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      userDestination,
    );
    const userAddress = userPublicKey.toBase58();
    console.log(`[kaminoPositions] Derived Solana address: ${userAddress}`);

    const rpc = createKaminoRpc();

    // Load the Kamino market
    console.log(`[kaminoPositions] Loading Kamino market: ${marketAddress}`);
    const market = await KaminoMarket.load(
      rpc,
      address(marketAddress),
      1000,
      PROGRAM_ID,
    );

    if (!market) {
      console.log(`[kaminoPositions] Market not found: ${marketAddress}`);
      return c.json({ error: `Market not found: ${marketAddress}` }, 404);
    }
    console.log(`[kaminoPositions] Market loaded successfully`);

    // Get all user obligations in this market
    console.log(`[kaminoPositions] Querying obligations for user: ${userAddress}`);
    const obligations = await market.getAllUserObligations(address(userAddress));
    console.log(`[kaminoPositions] Found ${obligations.length} obligations`);

    const response: KaminoPositionsResponse = {
      userAddress,
      marketAddress,
      obligations: obligations.map((obligation, idx) => {
        console.log(`[kaminoPositions] Processing obligation ${idx}: ${obligation.obligationAddress}`);
        const deposits: PositionInfo[] = [];
        const borrows: PositionInfo[] = [];

        // Process deposits
        console.log(`[kaminoPositions] Obligation ${idx} has ${obligation.deposits.size} deposits`);
        for (const [reserveAddr, position] of obligation.deposits) {
          const reserve = market.getReserveByAddress(reserveAddr);
          console.log(`[kaminoPositions]   Deposit: ${reserve?.symbol || 'unknown'} amount=${position.amount.toString()}`);
          deposits.push({
            reserveAddress: reserveAddr,
            mintAddress: reserve?.getLiquidityMint() || "unknown",
            symbol: reserve?.symbol || "unknown",
            depositedAmount: position.amount.toString(),
            depositedAmountUsd: position.marketValueRefreshed.toString(),
            borrowedAmount: "0",
            borrowedAmountUsd: "0",
          });
        }

        // Process borrows
        for (const [reserveAddr, position] of obligation.borrows) {
          const reserve = market.getReserveByAddress(reserveAddr);
          borrows.push({
            reserveAddress: reserveAddr,
            mintAddress: reserve?.getLiquidityMint() || "unknown",
            symbol: reserve?.symbol || "unknown",
            depositedAmount: "0",
            depositedAmountUsd: "0",
            borrowedAmount: position.amount.toString(),
            borrowedAmountUsd: position.marketValueRefreshed.toString(),
          });
        }

        return {
          obligationAddress: obligation.obligationAddress,
          deposits,
          borrows,
          totalDepositedUsd: obligation.refreshedStats.userTotalDeposit.toString(),
          totalBorrowedUsd: obligation.refreshedStats.userTotalBorrow.toString(),
          ltv: obligation.refreshedStats.loanToValue.toString(),
          liquidationLtv: obligation.refreshedStats.liquidationLtv.toString(),
        };
      }),
    };

    console.log(`[kaminoPositions] Returning response with ${response.obligations.length} obligations`);
    return c.json(response);
  } catch (err) {
    console.error("[kaminoPositions] Failed to fetch Kamino positions", err);
    return c.json(
      { error: (err as Error).message || "Failed to fetch positions" },
      500,
    );
  }
});

// Get positions across all known markets
app.get("/", async (c) => {
  const userDestination = c.req.query("userDestination");

  if (!userDestination) {
    return c.json({ error: "userDestination is required" }, 400);
  }

  try {
    // Derive the user's Solana address using the same path as deposits
    // userDestination is the NEAR account ID (e.g., "user.near")
    console.log(`[kaminoPositions] Root route - deriving address for userDestination: ${userDestination}`);
    console.log(`[kaminoPositions] Root route - derivation path: ${SOLANA_DEFAULT_PATH},${userDestination}`);

    const userPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      userDestination,
    );
    const userAddress = userPublicKey.toBase58();
    console.log(`[kaminoPositions] Root route - derived Solana address: ${userAddress}`);

    // Return the derived address and instructions
    return c.json({
      userAddress,
      message:
        "Use GET /:marketAddress?userDestination=... to query positions in a specific market",
      example: `/api/kamino-positions/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF?userDestination=${userDestination}`,
    });
  } catch (err) {
    console.error("[kaminoPositions] Failed to derive address", err);
    return c.json(
      { error: (err as Error).message || "Failed to derive address" },
      500,
    );
  }
});

export default app;
