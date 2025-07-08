# TradingView Webhook Example

This example shows how to run a simple webhook server that receives alerts from TradingView and sends orders to Drift using the SDK.

## Setup

1. Install dependencies from the repository root:
   ```bash
   yarn
   cd sdk && yarn && yarn build && cd ..
   ```
2. Install the example dependencies and build the TypeScript:
   ```bash
   cd examples/tradingview-webhook
   yarn init -y
   yarn add express @drift-labs/sdk @coral-xyz/anchor @solana/web3.js
   yarn add -D typescript ts-node
   npx tsc --init
   ```
3. Set environment variables in Render or your local shell:
   - `ANCHOR_WALLET` – path to your wallet keypair JSON file.
   - `ANCHOR_PROVIDER_URL` – RPC endpoint (e.g. `https://api.mainnet-beta.solana.com`).
   - `DRIFT_ENV` – network to use (`devnet` or `mainnet-beta`).

4. Start the server locally with:
   ```bash
   npx ts-node server.ts
   ```

## Deploying to Render

1. Create a new **Web Service** on [Render](https://render.com) and connect your fork of this repository.
2. Set the environment variables above in the Render dashboard.
3. Use `bash -c "yarn && cd sdk && yarn && yarn build && cd .. && npx ts-node examples/tradingview-webhook/server.ts"` as the start command.
4. The service will expose a public URL that you can use as the webhook endpoint.

## TradingView Alert Format

Create an alert in TradingView with the webhook URL from Render and use JSON payloads like:
```json
{
  "symbol": "SOL",
  "side": "LONG",
  "size": 1
}
```
`symbol` matches the perp market symbol on Drift, `side` can be `LONG` or `SHORT`, and `size` is the amount in base asset units.

## Server Endpoint

The example server exposes a `POST /webhook` endpoint. When it receives the JSON above it will place a market order on Drift.
