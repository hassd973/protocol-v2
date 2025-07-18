import {
	TransactionConfirmationStatus,
	AccountInfo,
	Keypair,
	PublicKey,
	Transaction,
	RpcResponseAndContext,
	Commitment,
	TransactionSignature,
	SignatureStatusConfig,
	SignatureStatus,
	GetVersionedTransactionConfig,
	GetTransactionConfig,
	VersionedTransaction,
	SimulateTransactionConfig,
	SimulatedTransactionResponse,
	TransactionReturnData,
	TransactionError,
	SignatureResultCallback,
	ClientSubscriptionId,
	Connection as SolanaConnection,
	SystemProgram,
	Blockhash,
	LogsFilter,
	LogsCallback,
	AccountChangeCallback,
	LAMPORTS_PER_SOL,
	AddressLookupTableAccount,
} from '@solana/web3.js';
import {
	ProgramTestContext,
	BanksClient,
	BanksTransactionResultWithMeta,
	Clock,
} from 'solana-bankrun';
import { BankrunProvider } from 'anchor-bankrun';
import bs58 from 'bs58';
import { BN, Wallet } from '@coral-xyz/anchor';
import { Account, unpackAccount } from '@solana/spl-token';
import { isVersionedTransaction } from '../tx/utils';

export type Connection = SolanaConnection | BankrunConnection;

type BankrunTransactionMetaNormalized = {
	logMessages: string[];
	err: TransactionError;
};

type BankrunTransactionRespose = {
	slot: number;
	meta: BankrunTransactionMetaNormalized;
};

export class BankrunContextWrapper {
	public readonly connection: BankrunConnection;
	public readonly context: ProgramTestContext;
	public readonly provider: BankrunProvider;
	public readonly commitment: Commitment = 'confirmed';

	constructor(context: ProgramTestContext, verifySignatures = true) {
		this.context = context;
		this.provider = new BankrunProvider(context);
		this.connection = new BankrunConnection(
			this.context.banksClient,
			this.context,
			verifySignatures
		);
	}

	async sendTransaction(
		tx: Transaction | VersionedTransaction,
		additionalSigners?: Keypair[]
	): Promise<TransactionSignature> {
		const isVersioned = isVersionedTransaction(tx);
		if (!additionalSigners) {
			additionalSigners = [];
		}
		if (isVersioned) {
			tx = tx as VersionedTransaction;
			tx.message.recentBlockhash = await this.getLatestBlockhash();
			if (!additionalSigners) {
				additionalSigners = [];
			}
			tx.sign([this.context.payer, ...additionalSigners]);
		} else {
			tx = tx as Transaction;
			tx.recentBlockhash = await this.getLatestBlockhash();
			tx.feePayer = this.context.payer.publicKey;
			tx.sign(this.context.payer, ...additionalSigners);
		}
		return await this.connection.sendTransaction(tx);
	}

	async getMinimumBalanceForRentExemption(_: number): Promise<number> {
		return 10 * LAMPORTS_PER_SOL;
	}

	async fundKeypair(
		keypair: Keypair | Wallet,
		lamports: number | bigint
	): Promise<TransactionSignature> {
		const ixs = [
			SystemProgram.transfer({
				fromPubkey: this.context.payer.publicKey,
				toPubkey: keypair.publicKey,
				lamports,
			}),
		];
		const tx = new Transaction().add(...ixs);
		return await this.sendTransaction(tx);
	}

	async getLatestBlockhash(): Promise<Blockhash> {
		const blockhash = await this.connection.getLatestBlockhash('finalized');

		return blockhash.blockhash;
	}

	printTxLogs(signature: string): void {
		this.connection.printTxLogs(signature);
	}

	async moveTimeForward(increment: number): Promise<void> {
		const approxSlots = increment / 0.4;
		const slot = await this.connection.getSlot();
		this.context.warpToSlot(BigInt(Math.floor(Number(slot) + approxSlots)));

		const currentClock = await this.context.banksClient.getClock();
		const newUnixTimestamp = currentClock.unixTimestamp + BigInt(increment);
		const newClock = new Clock(
			currentClock.slot,
			currentClock.epochStartTimestamp,
			currentClock.epoch,
			currentClock.leaderScheduleEpoch,
			newUnixTimestamp
		);

		await this.context.setClock(newClock);
	}

	async setTimestamp(unix_timestamp: number): Promise<void> {
		const currentClock = await this.context.banksClient.getClock();
		const newUnixTimestamp = BigInt(unix_timestamp);
		const newClock = new Clock(
			currentClock.slot,
			currentClock.epochStartTimestamp,
			currentClock.epoch,
			currentClock.leaderScheduleEpoch,
			newUnixTimestamp
		);
		await this.context.setClock(newClock);
	}
}

export class BankrunConnection {
	private readonly _banksClient: BanksClient;
	private readonly context: ProgramTestContext;
	private transactionToMeta: Map<
		TransactionSignature,
		BanksTransactionResultWithMeta
	> = new Map();
	private clock: Clock;

	private nextClientSubscriptionId = 0;
	private onLogCallbacks = new Map<number, LogsCallback>();
	private onAccountChangeCallbacks = new Map<
		number,
		[PublicKey, AccountChangeCallback]
	>();

	private verifySignatures: boolean;

	constructor(
		banksClient: BanksClient,
		context: ProgramTestContext,
		verifySignatures = true
	) {
		this._banksClient = banksClient;
		this.context = context;
		this.verifySignatures = verifySignatures;
	}

	getSlot(): Promise<bigint> {
		return this._banksClient.getSlot();
	}

	toConnection(): SolanaConnection {
		return this as unknown as SolanaConnection;
	}

	async getTokenAccount(publicKey: PublicKey): Promise<Account> {
		const info = await this.getAccountInfo(publicKey);
		return unpackAccount(publicKey, info, info.owner);
	}

	async getMultipleAccountsInfo(
		publicKeys: PublicKey[],
		_commitmentOrConfig?: Commitment
	): Promise<AccountInfo<Buffer>[]> {
		const accountInfos = [];

		for (const publicKey of publicKeys) {
			const accountInfo = await this.getAccountInfo(publicKey);
			accountInfos.push(accountInfo);
		}

		return accountInfos;
	}

	async getAccountInfo(
		publicKey: PublicKey
	): Promise<null | AccountInfo<Buffer>> {
		const parsedAccountInfo = await this.getParsedAccountInfo(publicKey);
		return parsedAccountInfo ? parsedAccountInfo.value : null;
	}

	async getAccountInfoAndContext(
		publicKey: PublicKey,
		_commitment?: Commitment
	): Promise<RpcResponseAndContext<null | AccountInfo<Buffer>>> {
		return await this.getParsedAccountInfo(publicKey);
	}
	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array | Array<number>,
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		_options?: any
	): Promise<TransactionSignature> {
		const tx = Transaction.from(rawTransaction);
		const signature = await this.sendTransaction(tx);
		return signature;
	}

	async sendTransaction(
		tx: Transaction | VersionedTransaction
	): Promise<TransactionSignature> {
		const isVersioned = isVersionedTransaction(tx);
		const serialized = isVersioned
			? tx.serialize()
			: tx.serialize({
					verifySignatures: this.verifySignatures,
			  });
		// @ts-ignore
		const internal = this._banksClient.inner;
		const inner = isVersioned
			? await internal.tryProcessVersionedTransaction(serialized)
			: await internal.tryProcessLegacyTransaction(serialized);
		const banksTransactionMeta = new BanksTransactionResultWithMeta(inner);

		const signature = isVersioned
			? bs58.encode((tx as VersionedTransaction).signatures[0])
			: bs58.encode((tx as Transaction).signatures[0].signature);

		if (banksTransactionMeta.result) {
			if (
				!banksTransactionMeta.result
					.toString()
					.includes('This transaction has already been processed')
			) {
				throw new Error(banksTransactionMeta.result);
			} else {
				console.log(
					`Tx already processed (sig: ${signature}): ${JSON.stringify(
						banksTransactionMeta
					)}`,
					banksTransactionMeta,
					banksTransactionMeta.result
				);
				console.log(tx);
			}
		}
		if (!this.transactionToMeta.has(signature)) {
			this.transactionToMeta.set(signature, banksTransactionMeta);
		}
		let finalizedCount = 0;
		while (finalizedCount < 10) {
			const signatureStatus = (await this.getSignatureStatus(signature)).value
				.confirmationStatus;
			if (signatureStatus.toString() == '"finalized"') {
				finalizedCount += 1;
			}
		}

		// update the clock slot/timestamp
		// sometimes race condition causes failures so we retry
		try {
			await this.updateSlotAndClock();
		} catch (e) {
			await this.updateSlotAndClock();
		}

		if (this.onLogCallbacks.size > 0) {
			const transaction = await this.getTransaction(signature);

			const context = { slot: transaction.slot };
			const logs = {
				logs: transaction.meta.logMessages,
				err: transaction.meta.err,
				signature,
			};
			for (const logCallback of this.onLogCallbacks.values()) {
				logCallback(logs, context);
			}
		}

		for (const [
			publicKey,
			callback,
		] of this.onAccountChangeCallbacks.values()) {
			const accountInfo = await this.getParsedAccountInfo(publicKey);
			callback(accountInfo.value, accountInfo.context);
		}

		return signature;
	}

	async updateSlotAndClock() {
		const currentSlot = await this.getSlot();
		const nextSlot = currentSlot + BigInt(1);
		this.context.warpToSlot(nextSlot);
		const currentClock = await this._banksClient.getClock();
		const newClock = new Clock(
			nextSlot,
			currentClock.epochStartTimestamp,
			currentClock.epoch,
			currentClock.leaderScheduleEpoch,
			currentClock.unixTimestamp + BigInt(1)
		);
		this.context.setClock(newClock);
		this.clock = newClock;
	}

	getTime(): number {
		return Number(this.clock.unixTimestamp);
	}

	async getParsedAccountInfo(
		publicKey: PublicKey
	): Promise<RpcResponseAndContext<AccountInfo<Buffer>>> {
		const accountInfoBytes = await this._banksClient.getAccount(publicKey);
		if (accountInfoBytes === null) {
			return {
				context: { slot: Number(await this._banksClient.getSlot()) },
				value: null,
			};
		}
		accountInfoBytes.data = Buffer.from(accountInfoBytes.data);
		const accountInfoBuffer = accountInfoBytes as AccountInfo<Buffer>;
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: accountInfoBuffer,
		};
	}

	async getLatestBlockhash(commitment?: Commitment): Promise<
		Readonly<{
			blockhash: string;
			lastValidBlockHeight: number;
		}>
	> {
		const blockhashAndBlockheight = await this._banksClient.getLatestBlockhash(
			commitment
		);
		return {
			blockhash: blockhashAndBlockheight[0],
			lastValidBlockHeight: Number(blockhashAndBlockheight[1]),
		};
	}

	async getAddressLookupTable(
		accountKey: PublicKey
	): Promise<RpcResponseAndContext<null | AddressLookupTableAccount>> {
		const { context, value: accountInfo } = await this.getParsedAccountInfo(
			accountKey
		);
		let value = null;
		if (accountInfo !== null) {
			value = new AddressLookupTableAccount({
				key: accountKey,
				state: AddressLookupTableAccount.deserialize(accountInfo.data),
			});
		}

		return {
			context,
			value,
		};
	}

	async getSignatureStatus(
		signature: string,
		_config?: SignatureStatusConfig
	): Promise<RpcResponseAndContext<null | SignatureStatus>> {
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature
		);
		if (transactionStatus === null) {
			return {
				context: { slot: Number(await this._banksClient.getSlot()) },
				value: null,
			};
		}
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: {
				slot: Number(transactionStatus.slot),
				confirmations: Number(transactionStatus.confirmations),
				err: transactionStatus.err,
				confirmationStatus:
					transactionStatus.confirmationStatus as TransactionConfirmationStatus,
			},
		};
	}

	/**
	 * There's really no direct equivalent to getTransaction exposed by SolanaProgramTest, so we do the best that we can here - it's a little hacky.
	 */
	async getTransaction(
		signature: string,
		_rawConfig?: GetTransactionConfig | GetVersionedTransactionConfig
	): Promise<BankrunTransactionRespose | null> {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		if (txMeta === undefined) {
			return null;
		}
		const transactionStatus = await this._banksClient.getTransactionStatus(
			signature
		);
		if (txMeta.meta === null) {
			throw new Error(`tx has no meta: ${JSON.stringify(txMeta)}`);
		}
		const meta: BankrunTransactionMetaNormalized = {
			logMessages: txMeta.meta.logMessages,
			err: txMeta.result,
		};
		return {
			slot: Number(transactionStatus.slot),
			meta,
		};
	}

	findComputeUnitConsumption(signature: string): bigint {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		if (txMeta === undefined) {
			throw new Error('Transaction not found');
		}
		return txMeta.meta.computeUnitsConsumed;
	}

	printTxLogs(signature: string): void {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		if (txMeta === undefined) {
			throw new Error('Transaction not found');
		}
		console.log(txMeta.meta.logMessages);
	}

	async simulateTransaction(
		transaction: Transaction | VersionedTransaction,
		_config?: SimulateTransactionConfig
	): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
		const simulationResult = await this._banksClient.simulateTransaction(
			transaction
		);
		const returnDataProgramId =
			simulationResult.meta?.returnData?.programId.toBase58();
		const returnDataNormalized = Buffer.from(
			simulationResult.meta?.returnData?.data
		).toString('base64');
		const returnData: TransactionReturnData = {
			programId: returnDataProgramId,
			data: [returnDataNormalized, 'base64'],
		};
		return {
			context: { slot: Number(await this._banksClient.getSlot()) },
			value: {
				err: simulationResult.result,
				logs: simulationResult.meta.logMessages,
				accounts: undefined,
				unitsConsumed: Number(simulationResult.meta.computeUnitsConsumed),
				returnData,
			},
		};
	}

	onSignature(
		signature: string,
		callback: SignatureResultCallback,
		commitment?: Commitment
	): ClientSubscriptionId {
		const txMeta = this.transactionToMeta.get(
			signature as TransactionSignature
		);
		this._banksClient.getSlot(commitment).then((slot) => {
			if (txMeta) {
				callback({ err: txMeta.result }, { slot: Number(slot) });
			}
		});
		return 0;
	}

	async removeSignatureListener(_clientSubscriptionId: number): Promise<void> {
		// Nothing actually has to happen here! Pretty cool, huh?
		// This function signature only exists to match the web3js interface
	}

	onLogs(
		filter: LogsFilter,
		callback: LogsCallback,
		_commitment?: Commitment
	): ClientSubscriptionId {
		const subscriptId = this.nextClientSubscriptionId;

		this.onLogCallbacks.set(subscriptId, callback);

		this.nextClientSubscriptionId += 1;

		return subscriptId;
	}

	async removeOnLogsListener(
		clientSubscriptionId: ClientSubscriptionId
	): Promise<void> {
		this.onLogCallbacks.delete(clientSubscriptionId);
	}

	onAccountChange(
		publicKey: PublicKey,
		callback: AccountChangeCallback,
		// @ts-ignore
		_commitment?: Commitment
	): ClientSubscriptionId {
		const subscriptId = this.nextClientSubscriptionId;

		this.onAccountChangeCallbacks.set(subscriptId, [publicKey, callback]);

		this.nextClientSubscriptionId += 1;

		return subscriptId;
	}

	async removeAccountChangeListener(
		clientSubscriptionId: ClientSubscriptionId
	): Promise<void> {
		this.onAccountChangeCallbacks.delete(clientSubscriptionId);
	}

	async getMinimumBalanceForRentExemption(_: number): Promise<number> {
		return 10 * LAMPORTS_PER_SOL;
	}
}

export function asBN(value: number | bigint): BN {
	return new BN(Number(value));
}
