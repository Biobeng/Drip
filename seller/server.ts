import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { GoogleGenAI } from "@google/genai";
import { formatUnits } from "viem";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;

if (!SELLER_ADDRESS) {
  console.error("ERROR: SELLER_ADDRESS is not set in .env. Exiting.");
  process.exit(1);
}
if (!BUYER_PRIVATE_KEY) {
  console.error("ERROR: BUYER_PRIVATE_KEY is not set in .env. Exiting.");
  process.exit(1);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set in .env. Exiting.");
  process.exit(1);
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

// ── Seller: Gateway middleware (Circle Dev Controlled Wallet receives) ───────
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: FACILITATOR_URL,
  onAfterVerify: (ctx: any) => console.log("[onAfterVerify]", JSON.stringify(ctx.result, null, 2)),
  onVerifyFailure: (ctx: any) => console.error("[onVerifyFailure]", JSON.stringify(ctx.error, null, 2)),
  onAfterSettle: (ctx: any) => console.log("[onAfterSettle]", JSON.stringify(ctx.result, null, 2)),
  onSettleFailure: (ctx: any) => console.error("[onSettleFailure]", JSON.stringify(ctx.error, null, 2)),
});

// ── Buyer: the autonomous Drip Agent (existing EOA wallet, pays via Gateway) ─
const agentClient = new GatewayClient({
  chain: "arcTestnet",
  privateKey: BUYER_PRIVATE_KEY,
});

// ── Feed log (for the live payment feed on the dashboard) ───────────────────
type FeedEntry = {
  id: number;
  action: string;
  endpoint: string;
  amount: string;
  status: "success" | "error";
  timestamp: string;
  txHash?: string;
};
const feedLog: FeedEntry[] = [];
let totalCalls = 0;
let totalDripped = 0;
let isRunning = false;

// Note: txHash here is Circle Gateway's internal settlement reference UUID,
// not a resolvable onchain transaction hash - it cannot be linked to a block
// explorer directly. It is still a legitimate audit reference and is kept in
// receipts, just not surfaced as a clickable "verify onchain" link in the UI.
function pushFeed(entry: Omit<FeedEntry, "id" | "timestamp">) {
  feedLog.unshift({ id: Date.now() + Math.random(), timestamp: new Date().toISOString(), ...entry });
  if (feedLog.length > 40) feedLog.pop();
}

// ── Chat sessions ─────────────────────────────────────────────────────────────
// Each session is its own paid conversation. Every message sent within a
// session is still its own $0.001 payment - sessions only group messages
// for display and give Gemini prior turns as context.
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  amount?: string;
  tier?: Tier;
  txHash?: string;
};
type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
  spentTotal: number;
};

// ── Spend limit guardrail ─────────────────────────────────────────────────────
// Each session has a hard budget cap. Once reached, the agent refuses to make
// further paid calls in that session, regardless of remaining wallet balance.
const SESSION_SPEND_LIMIT = parseFloat(process.env.SESSION_SPEND_LIMIT || "1.00");

const sessions = new Map<string, ChatSession>();

function getOrCreateSession(sessionId?: string): ChatSession {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId)!;
  const id = sessionId || randomUUID();
  const session: ChatSession = { id, title: "New conversation", createdAt: new Date().toISOString(), messages: [], spentTotal: 0 };
  sessions.set(id, session);
  return session;
}

const DEFAULT_QUERIES = [
  "What is Drip and how does it work?",
  "Tell me about DeFi opportunities on Arc",
  "What is the current price of USDC?",
  "How do agent-to-agent payments work?",
];
let queryIndex = 0;

// ── Pricing tiers ────────────────────────────────────────────────────────────
// Three price points reflecting the depth of what's being asked for, rather
// than one flat fee for every call regardless of value.
type Tier = "quick" | "detailed" | "longform";

const TIERS: Record<Tier, { price: string; label: string; route: string; maxTokens: number; guidance: string }> = {
  quick: {
    price: "$0.001",
    label: "Quick answer",
    route: "/ai-query/quick",
    maxTokens: 300,
    guidance: "Answer in 1 to 3 sentences. Be direct, no preamble.",
  },
  detailed: {
    price: "$0.005",
    label: "Detailed explanation",
    route: "/ai-query/detailed",
    maxTokens: 1200,
    guidance: "Give a thorough explanation, a few paragraphs, covering the topic properly with examples where useful.",
  },
  longform: {
    price: "$0.02",
    label: "Long-form content",
    route: "/ai-query/longform",
    maxTokens: 4096,
    guidance: "Write full long-form content: an article, essay, or complete piece. Follow any specific length or word count in the request exactly. Do not summarize or shorten - write the full thing.",
  },
};

// Option B: let the agent classify the prompt itself and pick a tier before
// paying, rather than the user picking manually. A lightweight heuristic
// first, falling back to a cheap Gemini classification call if ambiguous.
function classifyTierHeuristic(prompt: string): Tier | null {
  const p = prompt.toLowerCase();
  const wordCount = prompt.trim().split(/\s+/).length;

  const longformSignals = ["write an article", "write an essay", "write a blog", "write a story",
    "in-depth", "comprehensive", "detailed guide", "full breakdown", "word essay", "word article"];
  const detailedSignals = ["explain", "how does", "why does", "walk me through", "compare",
    "what are the differences", "describe in detail", "pros and cons"];

  if (longformSignals.some(s => p.includes(s))) return "longform";
  if (/\b\d{3,}\s*words?\b/.test(p)) return "longform"; // e.g. "300 words"
  if (detailedSignals.some(s => p.includes(s))) return "detailed";
  if (wordCount <= 12) return "quick";

  return null; // ambiguous - let the caller fall back to a model call
}

async function classifyTierWithModel(prompt: string): Promise<Tier> {
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: `Classify this request into exactly one word - "quick", "detailed", or "longform" - based on how much effort a good answer requires. "quick" = short factual question, one-line answer. "detailed" = needs explanation, comparison, or a few paragraphs. "longform" = an article, essay, story, or explicitly long content. Reply with only the single word.\n\nRequest: "${prompt}"`,
      config: { thinkingConfig: { thinkingLevel: "MINIMAL" }, maxOutputTokens: 10 },
    });
    const word = (response.text || "").trim().toLowerCase();
    if (word.includes("longform")) return "longform";
    if (word.includes("detailed")) return "detailed";
    return "quick";
  } catch {
    return "quick"; // fail safe to the cheapest tier
  }
}

async function classifyTier(prompt: string): Promise<Tier> {
  const heuristic = classifyTierHeuristic(prompt);
  if (heuristic) return heuristic;
  return classifyTierWithModel(prompt);
}

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/dashboard", (_req, res) => res.sendFile(join(__dirname, "dashboard.html")));

// ── RPC proxy (for balance reads from the browser) ───────────────────────────
app.post("/rpc", async (req, res) => {
  try {
    const r = await fetch("https://rpc.testnet.arc.network", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await r.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent status API - powers the live dashboard ─────────────────────────────
app.get("/api/agent/status", async (_req, res) => {
  try {
    const balances = await agentClient.getBalances();
    res.json({
      agent_wallet: agentAddress(),
      seller_wallet: SELLER_ADDRESS,
      seller_wallet_type: "Circle Developer Controlled Wallet",
      wallet_usdc: balances.wallet.formatted,
      gateway_balance: balances.gateway.formattedAvailable,
      total_calls: totalCalls,
      total_dripped: totalDripped.toFixed(6),
      is_running: isRunning,
      network: "Arc Testnet (eip155:5042002)",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/agent/feed", (_req, res) => {
  res.json({ feed: feedLog });
});

// ── Chat session endpoints ────────────────────────────────────────────────────
// List all sessions (id, title, message count, last activity) for the sidebar
app.get("/api/chats", (_req, res) => {
  const list = Array.from(sessions.values())
    .map(s => ({
      id: s.id,
      title: s.title,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      lastMessage: s.messages[s.messages.length - 1]?.content?.slice(0, 80) || "",
      spentTotal: s.spentTotal.toFixed(6),
      spendLimit: SESSION_SPEND_LIMIT.toFixed(2),
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ chats: list });
});

// Full history for one session
app.get("/api/chats/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Chat not found" });
  res.json({ ...session, spendLimit: SESSION_SPEND_LIMIT.toFixed(2) });
});

// Start a brand new empty session and return its id
app.post("/api/chats/new", (_req, res) => {
  const session = getOrCreateSession();
  res.json({ id: session.id });
});

// Downloadable plain-text receipt for a session - every message, its price,
// timestamp, and onchain transaction reference where available. Ledger-style
// formatting to match the product's own visual language.
app.get("/api/chats/:id/receipt", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Chat not found" });

  const lines: string[] = [];
  const divider = "-".repeat(56);

  lines.push("DRIP RECEIPT");
  lines.push(divider);
  lines.push(`Session   : ${session.id}`);
  lines.push(`Title     : ${session.title}`);
  lines.push(`Created   : ${session.createdAt}`);
  lines.push(`Network   : Arc Testnet (eip155:5042002)`);
  lines.push(`Seller    : ${SELLER_ADDRESS} (Circle Dev Controlled Wallet)`);
  lines.push(`Buyer     : ${agentAddress()}`);
  lines.push(divider);
  lines.push("");

  let running = 0;
  for (const m of session.messages) {
    if (m.role === "user") {
      running += m.amount ? parseFloat(m.amount.replace("$", "")) : 0;
      lines.push(`[PAID ${m.amount || "$0.000"}]  ${m.tier ? TIERS[m.tier].label : ""}`);
      lines.push(`  ${m.timestamp}`);
      lines.push(`  "${m.content}"`);
      if (m.txHash) {
        lines.push(`  gateway ref: ${m.txHash}`);
      }
      lines.push("");
    } else {
      lines.push(`  -> ${m.content}`);
      lines.push("");
    }
  }

  lines.push(divider);
  lines.push(`TOTAL PAID THIS SESSION : $${running.toFixed(6)} USDC`);
  lines.push(`SESSION SPEND LIMIT     : $${SESSION_SPEND_LIMIT.toFixed(2)} USDC`);
  lines.push(divider);
  lines.push("Drip - Autonomous Nanopayments on Arc");
  lines.push("github.com/Biobeng/Drip");

  const text = lines.join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="drip-receipt-${session.id.slice(0, 8)}.txt"`);
  res.send(text);
});

// Trigger a paid agent call: pays via Gateway, sends the prompt (with prior
// session context) to Gemini, appends both turns to the session, updates feed.
//
// Pricing mode is controlled by req.body.pricingMode:
//   "manual" (default) - uses req.body.tier if provided ("quick" | "detailed" | "longform"),
//                          otherwise defaults to "quick". This is Option A.
//   "auto"              - the agent classifies the prompt itself and picks the
//                          tier before paying. This is Option B.
app.post("/api/agent/run", async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: "Agent is already running a cycle." });
  }
  isRunning = true;

  try {
    const balances = await agentClient.getBalances();
    if (balances.gateway.available < 1_000n) {
      pushFeed({ action: "Depositing 1 USDC to Gateway", endpoint: "gateway.deposit", amount: "+1.000000 USDC", status: "success" });
      const deposit = await agentClient.deposit("1");
      pushFeed({ action: "Deposit confirmed", endpoint: deposit.depositTxHash.slice(0, 14) + "...", amount: "+1.000000 USDC", status: "success" });
    }

    const customPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const prompt = customPrompt.length > 0
      ? customPrompt.slice(0, 4000)
      : DEFAULT_QUERIES[queryIndex % DEFAULT_QUERIES.length];
    if (!customPrompt) queryIndex++;

    const pricingMode: "manual" | "auto" = req.body?.pricingMode === "auto" ? "auto" : "manual";

    let tier: Tier;
    if (pricingMode === "auto") {
      tier = await classifyTier(prompt);
      pushFeed({ action: `Agent classified request as "${TIERS[tier].label}"`, endpoint: "/api/classify-tier", amount: "free", status: "success" });
    } else {
      const requested = req.body?.tier;
      tier = (requested === "detailed" || requested === "longform") ? requested : "quick";
    }

    const session = getOrCreateSession(req.body?.sessionId);
    if (session.messages.length === 0) {
      session.title = prompt.slice(0, 48) + (prompt.length > 48 ? "..." : "");
    }

    const route = TIERS[tier].route;
    const priceLabel = TIERS[tier].price;
    const numericPrice = parseFloat(priceLabel.replace("$", ""));

    // Spend limit guardrail: refuse to pay if this session has already hit
    // its budget cap, regardless of how much USDC remains in the wallet.
    if (session.spentTotal + numericPrice > SESSION_SPEND_LIMIT) {
      isRunning = false;
      pushFeed({
        action: `Spend limit reached ($${SESSION_SPEND_LIMIT.toFixed(2)}) - call refused`,
        endpoint: route,
        amount: "blocked",
        status: "error",
      });
      return res.status(429).json({
        error: `Session spend limit of $${SESSION_SPEND_LIMIT.toFixed(2)} reached. Start a new conversation to continue.`,
        spentTotal: session.spentTotal.toFixed(6),
        spendLimit: SESSION_SPEND_LIMIT.toFixed(2),
      });
    }

    const { data, status } = await agentClient.pay(`${SELF_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, history: session.messages }),
    });

    if (status !== 200) {
      pushFeed({ action: "Payment failed", endpoint: route, amount: priceLabel + " USDC", status: "error" });
      isRunning = false;
      return res.status(402).json({ error: "Payment failed", details: data });
    }

    const result = (data as any).result;
    const txHash: string | undefined = (data as any)?.meta?.transaction || (data as any)?.transaction;
    const now = new Date().toISOString();
    session.messages.push({ role: "user", content: prompt, timestamp: now, amount: priceLabel, tier, txHash });
    session.messages.push({ role: "assistant", content: result, timestamp: now });
    session.spentTotal += numericPrice;

    totalCalls++;
    totalDripped += numericPrice;
    pushFeed({
      action: `Paid ${priceLabel} (${TIERS[tier].label}) for: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`,
      endpoint: route,
      amount: priceLabel + " USDC",
      status: "success",
      txHash,
    });

    isRunning = false;
    res.json({
      sessionId: session.id,
      prompt,
      result,
      tier,
      price: priceLabel,
      txHash,
      totalCalls,
      totalDripped: totalDripped.toFixed(6),
      sessionSpent: session.spentTotal.toFixed(6),
      sessionLimit: SESSION_SPEND_LIMIT.toFixed(2),
    });
  } catch (err: any) {
    isRunning = false;
    pushFeed({ action: "Agent cycle error", endpoint: "/ai-query", amount: "-", status: "error" });
    res.status(500).json({ error: err.message });
  }
});

function agentAddress(): string {
  return process.env.BUYER_ADDRESS || "0x5d240e8a07635a105f5905326c2abc44bf2aa0ae";
}

// ── General API info ──────────────────────────────────────────────────────────
app.get("/api/info", (_req, res) => {
  res.json({
    name: "Drip",
    tagline: "Autonomous nanopayments from AI agents to services on Arc",
    network: "Arc Testnet (eip155:5042002)",
    seller: SELLER_ADDRESS,
    seller_wallet_type: "Circle Developer Controlled Wallet",
    agent_wallet: agentAddress(),
    pricing_tiers: Object.entries(TIERS).map(([key, t]) => ({ tier: key, price: t.price, label: t.label })),
    github: "https://github.com/Biobeng/Drip",
    powered_by: ["Circle Gateway Nanopayments", "x402 Protocol", "Circle Developer Controlled Wallets"],
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "Drip Seller API", network: "Arc Testnet" });
});

// ── Shared Gemini call for all tiers ──────────────────────────────────────────
async function runGeminiForTier(tier: Tier, prompt: string, history: ChatMessage[] | undefined) {
  const priorTurns = Array.isArray(history)
    ? history.map((m: ChatMessage) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }))
    : [];
  const contents = [...priorTurns, { role: "user", parts: [{ text: prompt }] }];
  const t = TIERS[tier];

  const response = await genAI.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents,
    config: {
      systemInstruction: `You are the AI powering Drip, an autonomous nanopayment API on Arc Testnet. Every message you receive here has just been paid for individually via Circle Gateway, at the "${t.label}" price tier. ${t.guidance} Do not open by listing unrelated dictionary definitions of the word "drip" - you are the Drip service, not a dictionary. If asked about yourself, explain that you are powered by Gemini and paid for per-call via Circle Gateway Nanopayments on Arc.`,
      maxOutputTokens: t.maxTokens,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    },
  });

  return response.text || "No response generated.";
}

// ── Paid endpoints, one per pricing tier (Circle Gateway protected) ─────────
// Option A: the caller (user or frontend) picks the tier explicitly by
// choosing which of these three routes to call.
app.post("/ai-query/quick", gateway.require(TIERS.quick.price), async (req: PaidRequest, res) => {
  await handleTieredQuery("quick", req, res);
});

app.post("/ai-query/detailed", gateway.require(TIERS.detailed.price), async (req: PaidRequest, res) => {
  await handleTieredQuery("detailed", req, res);
});

app.post("/ai-query/longform", gateway.require(TIERS.longform.price), async (req: PaidRequest, res) => {
  await handleTieredQuery("longform", req, res);
});

async function handleTieredQuery(tier: Tier, req: PaidRequest, res: express.Response) {
  const { payer, amount, network, transaction } = req.payment!;
  const { prompt, history } = req.body;
  const formattedAmount = formatUnits(BigInt(amount), 6);
  console.log(`[DRIP] ${formattedAmount} USDC (${tier}) from ${payer} on ${network}`);
  console.log(`[QUERY] ${prompt}`);

  try {
    const result = await runGeminiForTier(tier, prompt, history);
    res.json({
      result,
      tier,
      transaction,
      meta: { paid_by: payer, amount_usdc: formattedAmount, network, transaction, timestamp: new Date().toISOString() },
    });
  } catch (err: any) {
    console.error("[GEMINI ERROR]", err.message);
    res.json({
      result: "Gemini API is temporarily unavailable, but your payment was settled successfully via Circle Gateway.",
      tier,
      transaction,
      meta: { paid_by: payer, amount_usdc: formattedAmount, network, transaction, timestamp: new Date().toISOString(), error: err.message },
    });
  }
}

// Option B: the agent classifies the prompt itself and decides which tier
// to pay for, before it pays. This endpoint is unpriced - it only returns
// the recommended tier so the caller can then pay and call the right
// /ai-query/{tier} route above. Classification itself is free since it is
// an internal agent decision, not a service being consumed.
app.post("/api/classify-tier", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const tier = await classifyTier(prompt);
    res.json({ tier, price: TIERS[tier].price, label: TIERS[tier].label });
  } catch (err: any) {
    res.json({ tier: "quick", price: TIERS.quick.price, label: TIERS.quick.label, note: "classification failed, defaulted to quick" });
  }
});

app.get("/market-data", gateway.require("$0.0001"), (req: PaidRequest, res) => {
  const { payer, amount, network } = req.payment!;
  const formattedAmount = formatUnits(BigInt(amount), 6);
  console.log(`[DRIP] ${formattedAmount} USDC from ${payer} on ${network}`);
  res.json({
    data: {
      arc_usdc_price: 1.0,
      block_height: Math.floor(Math.random() * 1000000) + 50000000,
      tps: (Math.random() * 1000 + 500).toFixed(2),
      active_agents: Math.floor(Math.random() * 200) + 50,
    },
    meta: { paid_by: payer, amount_usdc: formattedAmount, network, timestamp: new Date().toISOString() },
  });
});

app.listen(PORT, () => {
  console.log(`\nDrip running on port ${PORT}`);
  console.log(`Seller (Circle Dev Controlled Wallet): ${SELLER_ADDRESS}`);
  console.log(`Agent (Buyer wallet): ${agentAddress()}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`GitHub: https://github.com/Biobeng/Drip\n`);
});
