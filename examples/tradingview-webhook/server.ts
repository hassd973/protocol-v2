import express from 'express';
import { initialize, DriftClient, getMarketOrderParams, PositionDirection, PerpMarkets, BASE_PRECISION, Wallet, loadKeypair, User, BulkAccountLoader } from '@drift-labs/sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '@drift-labs/sdk';

async function main() {
  const env = process.env.DRIFT_ENV || 'mainnet-beta';
  const sdkConfig = initialize({ env });

  if (!process.env.ANCHOR_WALLET) {
    throw new Error('ANCHOR_WALLET env var must be set');
  }

  if (!process.env.ANCHOR_PROVIDER_URL) {
    throw new Error('ANCHOR_PROVIDER_URL env var must be set');
  }

  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL, 'confirmed');
  const wallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));

  const driftClient = new DriftClient({ connection, wallet, programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID) });
  const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);
  const user = new User({
    driftClient,
    userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
    accountSubscription: { type: 'polling', accountLoader }
  });

  await driftClient.subscribe();
  await user.subscribe();

  const app = express();
  app.use(express.json());

  app.post('/webhook', async (req, res) => {
    try {
      const { symbol, side, size } = req.body;
      const marketInfo = PerpMarkets[env].find((m) => m.baseAssetSymbol === symbol);
      if (!marketInfo) {
        throw new Error('Unknown market symbol');
      }
      const direction = side === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT;
      const marketIndex = marketInfo.marketIndex;
      const orderParams = getMarketOrderParams({
        baseAssetAmount: new BN(size).mul(BASE_PRECISION),
        direction,
        marketIndex
      });
      const tx = await driftClient.placePerpOrder(orderParams);
      res.json({ success: true, tx });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`listening on port ${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
