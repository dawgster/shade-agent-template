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
  const nearPublicKey = c.req.query("nearPublicKey");

  if (!marketAddress) {
    return c.json({ error: "marketAddress is required" }, 400);
  }

  try {
    // Derive the user's Solana address from their NEAR public key
    const userPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      nearPublicKey,
    );
    const userAddress = userPublicKey.toBase58();

    const rpc = createKaminoRpc();

    // Load the Kamino market
    const market = await KaminoMarket.load(
      rpc,
      address(marketAddress),
      1000,
      PROGRAM_ID,
    );

    if (!market) {
      return c.json({ error: `Market not found: ${marketAddress}` }, 404);
    }

    // Get all user obligations in this market
    const obligations = await market.getAllUserObligations(address(userAddress));

    const response: KaminoPositionsResponse = {
      userAddress,
      marketAddress,
      obligations: obligations.map((obligation) => {
        const deposits: PositionInfo[] = [];
        const borrows: PositionInfo[] = [];

        // Process deposits
        for (const [reserveAddr, position] of obligation.deposits) {
          const reserve = market.getReserveByAddress(reserveAddr);
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

    return c.json(response);
  } catch (err) {
    console.error("Failed to fetch Kamino positions", err);
    return c.json(
      { error: (err as Error).message || "Failed to fetch positions" },
      500,
    );
  }
});

// Get positions across all known markets
app.get("/", async (c) => {
  const nearPublicKey = c.req.query("nearPublicKey");

  try {
    const userPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      nearPublicKey,
    );
    const userAddress = userPublicKey.toBase58();

    // Return the derived address and instructions
    return c.json({
      userAddress,
      message:
        "Use GET /:marketAddress?nearPublicKey=... to query positions in a specific market",
      example: `/api/kamino-positions/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF?nearPublicKey=${nearPublicKey || "ed25519:..."}`,
    });
  } catch (err) {
    console.error("Failed to derive address", err);
    return c.json(
      { error: (err as Error).message || "Failed to derive address" },
      500,
    );
  }
});

export default app;
