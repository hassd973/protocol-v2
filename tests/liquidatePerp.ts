import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	ContractTier,
	EventSubscriber,
	isVariant,
	LIQUIDATION_PCT_PRECISION,
	OracleGuardRails,
	OracleSource,
	PositionDirection,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TestClient,
	User,
	Wallet,
	ZERO,
} from '../sdk/src';
import { assert } from 'chai';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	sleep,
} from './testHelpers';
import { PERCENTAGE_PRECISION, UserStatus } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('liquidate perp (no open orders)', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorDriftClient: TestClient;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	const nLpShares = ZERO;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION,
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.muln(100),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(11), // allow 11x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,

			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(175).mul(BASE_PRECISION).div(new BN(10)), // 17.5 SOL
			0,
			new BN(0)
		);

		bankrunContextWrapper.fundKeypair(liquidatorKeyPair, LAMPORTS_PER_SOL);
		liquidatorUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			liquidatorKeyPair.publicKey
		);
		liquidatorDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(liquidatorKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await liquidatorDriftClient.subscribe();

		await liquidatorDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const marketIndex = 0;
		const lpShares = driftClient.getUserAccount().perpPositions[0].lpShares;
		assert(lpShares.eq(nLpShares));

		const driftClientUser = new User({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const mtc = driftClientUser.getTotalCollateral('Maintenance');
		const mmr = driftClientUser.getMaintenanceMarginRequirement();
		const pp = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq = mtc.sub(mmr); // QUOTE_PRECISION
		console.log('mtc:', mtc.toString());
		console.log('mmr:', mmr.toString());
		console.log('deltaValueToLiq:', deltaValueToLiq.toString());
		console.log('pp.base:', pp.baseAssetAmount.toString());

		const expectedLiqPrice = 0.45219;
		const liqPrice = driftClientUser.liquidationPrice(0, ZERO);
		console.log('liqPrice:', liqPrice.toString());
		assert(liqPrice.eq(new BN(expectedLiqPrice * PRICE_PRECISION.toNumber())));

		const oracle = driftClient.getPerpMarketAccount(0).amm.oracle;
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.9, oracle);
		await sleep(2000);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const oraclePrice = driftClient.getOracleDataForPerpMarket(0).price;
		console.log('oraclePrice:', oraclePrice.toString());
		assert(oraclePrice.eq(new BN(0.9 * PRICE_PRECISION.toNumber())));
		const liqPriceAfterPxChange = driftClientUser.liquidationPrice(0, ZERO);

		console.log('liqPriceAfterPxChange:', liqPriceAfterPxChange.toString());
		const mtc0 = driftClientUser.getTotalCollateral('Maintenance');
		const mmr0 = driftClientUser.getMaintenanceMarginRequirement();
		const pp0 = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq0 = mtc0.sub(mmr0); // QUOTE_PRECISION
		console.log('mtc0:', mtc0.toString());
		console.log('mmr0:', mmr0.toString());
		console.log('deltaValueToLiq0:', deltaValueToLiq0.toString());
		console.log('pp.base0:', pp0.baseAssetAmount.toString());
		assert(
			liqPriceAfterPxChange.eq(
				new BN(expectedLiqPrice * PRICE_PRECISION.toNumber())
			)
		);

		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);
		await sleep(2000);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const oraclePrice2 = driftClient.getOracleDataForPerpMarket(0).price;
		console.log('oraclePrice2:', oraclePrice2.toString());
		assert(oraclePrice2.eq(new BN(0.9 * PRICE_PRECISION.toNumber())));
		const liqPriceAfterSettlePnl = driftClientUser.liquidationPrice(0, ZERO);

		const mtc2 = driftClientUser.getTotalCollateral('Maintenance');
		const mmr2 = driftClientUser.getMaintenanceMarginRequirement();
		const pp2 = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq2 = mtc2.sub(mmr2); // QUOTE_PRECISION
		console.log('mtc2:', mtc2.toString());
		console.log('mmr2:', mmr2.toString());
		console.log('deltaValueToLiq2:', deltaValueToLiq2.toString());
		console.log('pp.base2:', pp2.baseAssetAmount.toString());

		console.log('liqPriceAfterSettlePnl:', liqPriceAfterSettlePnl.toString());
		assert(
			liqPriceAfterSettlePnl.eq(
				new BN(expectedLiqPrice * PRICE_PRECISION.toNumber())
			)
		);

		await setFeedPriceNoProgram(bankrunContextWrapper, 1.1, oracle);
		await sleep(2000);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const oraclePrice3 = driftClient.getOracleDataForPerpMarket(0).price;
		console.log('oraclePrice3:', oraclePrice3.toString());
		assert(oraclePrice3.eq(new BN(1099999)));
		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);

		const liqPriceAfterRallySettlePnl = driftClientUser.liquidationPrice(
			0,
			ZERO
		);
		console.log(
			'liqPriceAfterRallySettlePnl:',
			liqPriceAfterRallySettlePnl.toString()
		);
		assert(
			liqPriceAfterRallySettlePnl.eq(
				new BN(expectedLiqPrice * PRICE_PRECISION.toNumber())
			)
		);
		await driftClientUser.unsubscribe();

		await setFeedPriceNoProgram(bankrunContextWrapper, 0.1, oracle);

		const txSig1 = await liquidatorDriftClient.setUserStatusToBeingLiquidated(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount()
		);
		console.log('setUserStatusToBeingLiquidated txSig:', txSig1);
		assert(driftClient.getUserAccount().status === UserStatus.BEING_LIQUIDATED);

		const txSig = await liquidatorDriftClient.liquidatePerp(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		for (let i = 0; i < 32; i++) {
			assert(!isVariant(driftClient.getUserAccount().orders[i].status, 'open'));
		}

		assert(
			liquidatorDriftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(17500000000))
		);

		assert(driftClient.getUserAccount().status === UserStatus.BEING_LIQUIDATED);
		assert(driftClient.getUserAccount().nextLiquidationId === 2);

		// try to add liq when being liquidated -- should fail
		try {
			await driftClient.addPerpLpShares(nLpShares, 0);
			assert(false);
		} catch (err) {
			assert(err.message.includes('0x17e5'));
		}

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		assert(liquidationRecord.liquidatePerp.marketIndex === 0);
		assert(liquidationRecord.canceledOrderIds.length === 0);
		assert(
			liquidationRecord.liquidatePerp.oraclePrice.eq(
				PRICE_PRECISION.div(new BN(10))
			)
		);
		assert(
			liquidationRecord.liquidatePerp.baseAssetAmount.eq(new BN(-17500000000))
		);

		assert(
			liquidationRecord.liquidatePerp.quoteAssetAmount.eq(new BN(1750000))
		);
		assert(liquidationRecord.liquidatePerp.lpShares.eq(nLpShares));
		assert(liquidationRecord.liquidatePerp.ifFee.eq(new BN(0)));
		assert(liquidationRecord.liquidatePerp.liquidatorFee.eq(new BN(0)));

		const fillRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(fillRecord.action, 'fill'));
		assert(fillRecord.marketIndex === 0);
		assert(isVariant(fillRecord.marketType, 'perp'));
		assert(fillRecord.baseAssetAmountFilled.eq(new BN(17500000000)));
		assert(fillRecord.quoteAssetAmountFilled.eq(new BN(1750000)));
		assert(fillRecord.takerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.takerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		assert(fillRecord.takerFee.eq(new BN(0)));
		assert(isVariant(fillRecord.takerOrderDirection, 'short'));
		assert(fillRecord.makerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.makerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		console.log(fillRecord.makerFee.toString());
		assert(fillRecord.makerFee.eq(new BN(ZERO)));
		assert(isVariant(fillRecord.makerOrderDirection, 'long'));

		assert(fillRecord.takerExistingQuoteEntryAmount.eq(new BN(17500007)));
		assert(fillRecord.takerExistingBaseAssetAmount === null);
		assert(fillRecord.makerExistingQuoteEntryAmount === null);
		assert(fillRecord.makerExistingBaseAssetAmount === null);

		const _sig2 = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount
		);

		await driftClient.fetchAccounts();
		assert(driftClient.getUserAccount().status === UserStatus.BANKRUPT);
		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-5767653))
		);

		// try to add liq when bankrupt -- should fail
		try {
			await driftClient.addPerpLpShares(nLpShares, 0);
			assert(false);
		} catch (err) {
			// cant add when bankrupt
			assert(err.message.includes('0x17ed'));
		}

		await driftClient.updatePerpMarketContractTier(0, ContractTier.A);
		const tx1 = await driftClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		bankrunContextWrapper.connection.printTxLogs(tx1);

		await driftClient.fetchAccounts();
		const marketBeforeBankruptcy =
			driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketBeforeBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteMaxInsurance.eq(
				QUOTE_PRECISION
			)
		);
		assert(marketBeforeBankruptcy.amm.totalSocialLoss.eq(ZERO));
		const _sig = await liquidatorDriftClient.resolvePerpBankruptcy(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		await driftClient.fetchAccounts();
		// all social loss
		const marketAfterBankruptcy = driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketAfterBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(marketAfterBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO));
		assert(
			marketAfterBankruptcy.insuranceClaim.quoteMaxInsurance.eq(QUOTE_PRECISION)
		);
		assert(marketAfterBankruptcy.amm.feePool.scaledBalance.eq(ZERO));
		console.log(
			'marketAfterBankruptcy.amm.totalSocialLoss:',
			marketAfterBankruptcy.amm.totalSocialLoss.toString()
		);
		assert(marketAfterBankruptcy.amm.totalSocialLoss.eq(new BN(5750007)));

		// assert(!driftClient.getUserAccount().isBankrupt);
		// assert(!driftClient.getUserAccount().isBeingLiquidated);
		assert(
			(driftClient.getUserAccount().status &
				(UserStatus.BANKRUPT | UserStatus.BEING_LIQUIDATED)) ===
				0
		);

		console.log(driftClient.getUserAccount());
		// assert(
		// 	driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		// );
		// assert(driftClient.getUserAccount().perpPositions[0].lpShares.eq(ZERO));

		const perpBankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(isVariant(perpBankruptcyRecord.liquidationType, 'perpBankruptcy'));
		assert(perpBankruptcyRecord.perpBankruptcy.marketIndex === 0);
		console.log(perpBankruptcyRecord.perpBankruptcy.pnl.toString());
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(perpBankruptcyRecord.perpBankruptcy.pnl.eq(new BN(-5767653)));
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.eq(
				new BN(328572000)
			)
		);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(
			market.amm.cumulativeFundingRateLong.toString(),
			market.amm.cumulativeFundingRateShort.toString()
		);
		assert(market.amm.cumulativeFundingRateLong.eq(new BN(328580333)));
		assert(market.amm.cumulativeFundingRateShort.eq(new BN(-328563667)));
	});
});
