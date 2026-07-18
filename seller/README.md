# Drip

Autonomous nanopayments from an AI agent to a live service on Arc Testnet.

Drip is a single deployed service where an autonomous agent pays for its own API calls, live, in front of anyone watching. There is no checkout flow and no "connect your wallet to pay" — the agent has its own funded wallet and pays for itself using Circle Gateway Nanopayments and the x402 protocol.

## Live Demo

The whole thing runs from one server. Visit the deployed URL, click **Run Agent Now**, and watch:

1. The agent check its Circle Gateway balance
2. Deposit USDC if needed
3. Sign an EIP-3009 payment authorization offchain, zero gas
4. Call the paid `/ai-query` endpoint
5. Settle the payment through Circle Gateway on Arc Testnet
6. Return a real response

Every step is real and reflected in the live payment feed.

## Architecture

- **Seller wallet**: a Circle Developer Controlled Wallet, visible and manageable in Circle Console, receives every payment
- **Buyer agent wallet**: an existing funded EOA wallet, signs payments autonomously via Circle Gateway
- **Server**: a single Express app that both serves the paid endpoints AND runs the agent that pays them, exposed through a small dashboard API

## Stack

- Circle Gateway Nanopayments (`@circle-fin/x402-batching@3.2.0`)
- Circle Developer Controlled Wallets (seller wallet)
- Google Gemini API (real inference, powers /ai-query, free tier)
- x402 Protocol
- TypeScript / Node.js / Express
- React (frontend, served directly from Express)
- Arc Testnet (eip155:5042002)

## Setup

```bash
cd seller
cp .env.example .env
# Fill in BUYER_PRIVATE_KEY - this wallet needs testnet USDC from https://faucet.circle.com
npm install
npm start
```

You will also need a free Gemini API key from https://aistudio.google.com for the `/ai-query` endpoint to return real AI responses. No credit card required.

Visit `http://localhost:3000` and click **Run Agent Now**.

## Paid Endpoints

| Endpoint | Method | Price |
|---|---|---|
| `/health` | GET | Free |
| `/ai-query` | POST | $0.001 USDC |
| `/market-data` | GET | $0.0001 USDC |

## Dashboard API (powers the frontend)

| Endpoint | Description |
|---|---|
| `GET /api/agent/status` | Current wallet balances and run state |
| `GET /api/agent/feed` | Recent payment activity log |
| `POST /api/agent/run` | Triggers one live autonomous payment cycle |

## Circle Products Used

- USDC on Arc Testnet
- Developer Controlled Wallets (seller)
- Gateway Nanopayments
- x402 Protocol

## Wallets

**Seller (Circle Developer Controlled Wallet)**
- Circle Wallet ID: ac359945-1f0a-50f0-b44e-365599e447f3
- Address: 0x82d4c416dd2b68afa3461ea1dddcc352cafad8d1
- Network: Arc Testnet (ARC-TESTNET)
- Receives all USDC payments

**Buyer Agent (EOA wallet)**
- Address: 0x5d240e8a07635a105f5905326c2abc44bf2aa0ae
- Signs EIP-3009 payment authorizations autonomously via Circle Gateway
