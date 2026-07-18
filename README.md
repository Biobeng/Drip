# Drip

Autonomous nanopayments from AI agents to services on Arc Testnet.

Drip lets AI agents pay for API services continuously and autonomously using Circle Gateway Nanopayments and the x402 protocol. No human needed in the payment loop.

## What makes Drip different from v1

- Circle Developer Controlled Wallets replaces raw private key management
- The agent fetches its own wallet details and USDC balance from Circle's API at startup
- Full wallet visibility through Circle Console
- Gateway Nanopayments still powers the per-call payment flow

## Stack

- Circle Developer Controlled Wallets
- Circle Gateway Nanopayments (@circle-fin/x402-batching@3.2.0)
- x402 Protocol
- TypeScript / Node.js
- Express.js (seller)
- Arc Testnet (eip155:5042002)

## Setup

### Seller

```bash
cd seller
cp .env.example .env
npm install
npm start
```

### Buyer Agent

```bash
cd buyer
cp .env.example .env
# Fill in BUYER_PRIVATE_KEY in .env
npm install
npm run run-agent
```

## How it works

1. Drip agent initializes and fetches its Circle Developer Controlled Wallet
2. Agent checks Gateway balance and deposits USDC if needed
3. Agent calls a paid endpoint on the Drip Seller API
4. Seller returns HTTP 402 with payment requirements
5. Agent signs an EIP-3009 authorization offchain — zero gas
6. Agent retries with Payment-Signature header
7. Circle Gateway verifies and settles the payment on Arc Testnet

## Circle Products Used

- USDC on Arc Testnet
- Developer Controlled Wallets
- Gateway Nanopayments
- x402 Protocol

## Wallets

**Seller (Circle Developer Controlled Wallet)**
- Circle Wallet ID: ac359945-1f0a-50f0-b44e-365599e447f3
- Address: 0x82d4c416dd2b68afa3461ea1dddcc352cafad8d1
- Network: Arc Testnet (ARC-TESTNET)
- Receives all USDC payments from the buyer agent
- Visible and manageable in Circle Console

**Buyer (existing EOA wallet)**
- Address: 0x5d240e8a07635a105f5905326c2abc44bf2aa0ae
- Signs EIP-3009 payment authorizations via Circle Gateway
