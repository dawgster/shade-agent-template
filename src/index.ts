import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { startQueueConsumer } from "./queue/consumer";
import { config } from "./config";

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.development.local" });
}

// Import routes
import ethAccount from "./routes/ethAccount";
import agentAccount from "./routes/agentAccount";
import transaction from "./routes/transaction";
import status from "./routes/status";
import chainsigTest from "./routes/chainsigTest";
import intents from "./routes/intents";
import solAccount from "./routes/solAccount";
import kaminoPositions from "./routes/kaminoPositions";

const app = new Hono();

// Configure CORS to restrict access to the server
app.use(cors());

// Health check
app.get("/", (c) => c.json({ message: "App is running" }));

// Routes
app.route("/api/eth-account", ethAccount);
app.route("/api/agent-account", agentAccount);
app.route("/api/transaction", transaction);
app.route("/api/status", status);
app.route("/api/chainsig-test", chainsigTest);
app.route("/api/intents", intents);
app.route("/api/sol-account", solAccount);
app.route("/api/kamino-positions", kaminoPositions);

// Start the server
const port = Number(process.env.PORT || "3000");

console.log(`App is running on port ${port}`);

serve({ fetch: app.fetch, port });

if (config.enableQueue) {
  startQueueConsumer().catch((err) => {
    console.error("Failed to start queue consumer", err);
  });
} else {
  console.log("Queue consumer disabled (enable via ENABLE_QUEUE=true)");
}
