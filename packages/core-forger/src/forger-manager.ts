import { Container, Contracts, Enums, Utils as AppUtils } from "@arkecosystem/core-kernel";
import { NetworkStateStatus } from "@arkecosystem/core-p2p";
import { Blocks, Crypto, Interfaces, Managers, Transactions } from "@arkecosystem/crypto";

import { Client } from "./client";
import { Delegate } from "./delegate";
import { HostNoResponseError, RelayCommunicationError } from "./errors";

// todo: review the implementation - quite a mess right now with quite a few responsibilities
@Container.injectable()
export class ForgerManager {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Log.Logger;

    private client!: Client;
    private delegates: Delegate[] = [];
    private usernames: { [key: string]: string } = {};
    private isStopped: boolean = false;
    private round: Contracts.P2P.CurrentRound | undefined;
    private initialized: boolean = false;

    init(options) {
        this.client = this.app.resolve<Client>(Client);
        this.client.init(options.hosts);
    }

    public async startForging(bip38?: string, password?: string): Promise<void> {
        const secrets = this.app.config("delegates").secrets;

        if (!bip38 && (!secrets || !secrets.length || !Array.isArray(secrets))) {
            this.logger.warning('No delegate found! Please check your "delegates.json" file and try again.');
            return;
        }

        this.delegates = AppUtils.uniq<string>(secrets.map(secret => secret.trim())).map(
            passphrase => new Delegate(passphrase, Managers.configManager.get("network"), password),
        );

        if (bip38) {
            this.logger.info("BIP38 Delegate loaded");

            this.delegates.push(new Delegate(bip38, Managers.configManager.get("network"), password));
        }

        if (!this.delegates) {
            this.logger.warning('No delegate found! Please check your "delegates.json" file and try again.');
            return;
        }

        let timeout: number = 2000;
        try {
            await this.loadRound();

            timeout = Crypto.Slots.getTimeInMsUntilNextSlot();
        } catch (error) {
            this.logger.warning("Waiting for a responsive host.");
        } finally {
            this.checkLater(timeout);
        }
    }

    public async stopForging(): Promise<void> {
        this.isStopped = true;
    }

    // @todo: make this private
    public async checkSlot(): Promise<void> {
        try {
            if (this.isStopped) {
                return;
            }

            await this.loadRound();

            const currentRound: Contracts.P2P.CurrentRound = AppUtils.assert.defined(this.round);

            if (!currentRound.canForge) {
                // basically looping until we lock at beginning of next slot
                return this.checkLater(200);
            }

            const delegate: Delegate | undefined = this.isActiveDelegate(
                AppUtils.assert.defined(currentRound.currentForger.publicKey),
            );

            if (!delegate) {
                const nextForger: string = AppUtils.assert.defined(currentRound.nextForger.publicKey);

                if (this.isActiveDelegate(nextForger)) {
                    const username = this.usernames[nextForger];

                    this.logger.info(`Next forging delegate ${username} (${nextForger}) is active on this node.`);

                    await this.client.syncWithNetwork();
                }

                return this.checkLater(Crypto.Slots.getTimeInMsUntilNextSlot());
            }

            const networkState: Contracts.P2P.NetworkState = await this.client.getNetworkState();

            if (networkState.nodeHeight !== currentRound.lastBlock.height) {
                this.logger.warning(
                    `The NetworkState height (${networkState.nodeHeight}) and round height (${currentRound.lastBlock.height}) are out of sync. This indicates delayed blocks on the network.`,
                );
            }

            if (this.isForgingAllowed(networkState, delegate)) {
                await this.forgeNewBlock(delegate, currentRound, networkState);
            }

            return this.checkLater(Crypto.Slots.getTimeInMsUntilNextSlot());
        } catch (error) {
            if (error instanceof HostNoResponseError || error instanceof RelayCommunicationError) {
                if (error.message.includes("blockchain isn't ready")) {
                    this.logger.info("Waiting for relay to become ready.");
                } else {
                    this.logger.warning(error.message);
                }
            } else {
                const currentRound: Contracts.P2P.CurrentRound = AppUtils.assert.defined(this.round);

                this.logger.error(error.stack);

                if (!AppUtils.isEmpty(currentRound)) {
                    this.logger.info(
                        `Round: ${currentRound.current.toLocaleString()}, height: ${currentRound.lastBlock.height.toLocaleString()}`,
                    );
                }

                this.client.emitEvent(Enums.Events.State.ForgerFailed, { error: error.message });
            }

            // no idea when this will be ok, so waiting 2s before checking again
            return this.checkLater(2000);
        }
    }

    public async forgeNewBlock(
        delegate: Delegate,
        round: Contracts.P2P.CurrentRound,
        networkState: Contracts.P2P.NetworkState,
    ): Promise<void> {
        Managers.configManager.setHeight(AppUtils.assert.defined(networkState.nodeHeight));

        const transactions: Interfaces.ITransactionData[] = await this.getTransactionsForForging();

        const block: Interfaces.IBlock = AppUtils.assert.defined(
            delegate.forge(transactions, {
                previousBlock: {
                    id: networkState.lastBlockId,
                    idHex: Managers.configManager.getMilestone().block.idFullSha256
                        ? networkState.lastBlockId
                        : Blocks.Block.toBytesHex(networkState.lastBlockId),
                    height: networkState.nodeHeight,
                },
                timestamp: round.timestamp,
                reward: round.reward,
            }),
        );

        const minimumMs = 2000;
        const timeLeftInMs: number = Crypto.Slots.getTimeInMsUntilNextSlot();
        const currentSlot: number = Crypto.Slots.getSlotNumber();
        const roundSlot: number = Crypto.Slots.getSlotNumber(round.timestamp);
        const prettyName = `${this.usernames[AppUtils.assert.defined<string>(delegate.publicKey)]} (${
            delegate.publicKey
        })`;

        if (timeLeftInMs >= minimumMs && currentSlot === roundSlot) {
            this.logger.info(`Forged new block ${block.data.id} by delegate ${prettyName}`);

            await this.client.broadcastBlock(block.toJson());

            this.client.emitEvent(Enums.Events.State.BlockForged, block.data);

            for (const transaction of transactions) {
                this.client.emitEvent(Enums.Events.State.TransactionForged, transaction);
            }
        } else {
            if (currentSlot !== roundSlot) {
                this.logger.warning(
                    `Failed to forge new block by delegate ${prettyName}, because already in next slot.`,
                );
            } else {
                this.logger.warning(
                    `Failed to forge new block by delegate ${prettyName}, because there were ${timeLeftInMs}ms left in the current slot (less than ${minimumMs}ms).`,
                );
            }
        }
    }

    public async getTransactionsForForging(): Promise<Interfaces.ITransactionData[]> {
        const response: Contracts.P2P.ForgingTransactions = await this.client.getTransactions();

        if (AppUtils.isEmpty(response)) {
            this.logger.error("Could not get unconfirmed transactions from transaction pool.");

            return [];
        }

        const transactions: Interfaces.ITransactionData[] = response.transactions.map(
            (hex: string) => Transactions.TransactionFactory.fromBytesUnsafe(Buffer.from(hex, "hex")).data,
        );

        this.logger.debug(
            `Received ${AppUtils.pluralize("transaction", transactions.length, true)} from the pool containing ${
                response.poolSize
            }`,
        );

        return transactions;
    }

    public isForgingAllowed(networkState: Contracts.P2P.NetworkState, delegate: Delegate): boolean {
        if (networkState.status === NetworkStateStatus.Unknown) {
            this.logger.info("Failed to get network state from client. Will not forge.");
            return false;
        } else if (networkState.status === NetworkStateStatus.ColdStart) {
            this.logger.info("Skipping slot because of cold start. Will not forge.");
            return false;
        } else if (networkState.status === NetworkStateStatus.BelowMinimumPeers) {
            this.logger.info("Network reach is not sufficient to get quorum. Will not forge.");
            return false;
        }

        const overHeightBlockHeaders: Array<{
            [id: string]: any;
        }> = networkState.getOverHeightBlockHeaders();
        if (overHeightBlockHeaders.length > 0) {
            this.logger.info(
                `Detected ${AppUtils.pluralize(
                    "distinct overheight block header",
                    overHeightBlockHeaders.length,
                    true,
                )}.`,
            );

            for (const overHeightBlockHeader of overHeightBlockHeaders) {
                if (overHeightBlockHeader.generatorPublicKey === delegate.publicKey) {
                    const username: string = this.usernames[AppUtils.assert.defined<string>(delegate.publicKey)];

                    this.logger.warning(
                        `Possible double forging delegate: ${username} (${delegate.publicKey}) - Block: ${overHeightBlockHeader.id}.`,
                    );
                }
            }
        }

        if (networkState.getQuorum() < 0.66) {
            this.logger.info("Fork 6 - Not enough quorum to forge next block. Will not forge.");
            this.logger.debug(`Network State: ${networkState.toJson()}`);

            return false;
        }

        return true;
    }

    private isActiveDelegate(publicKey: string): Delegate | undefined {
        return this.delegates.find(delegate => delegate.publicKey === publicKey);
    }

    private async loadRound(): Promise<void> {
        this.round = await this.client.getRound();

        this.usernames = this.round.delegates.reduce(
            (acc, wallet) =>
                Object.assign(acc, { [AppUtils.assert.defined<string>(wallet.publicKey)]: wallet.delegate.username }),
            {},
        );

        if (!this.initialized) {
            this.printLoadedDelegates();

            // @ts-ignore
            this.client.emitEvent(Enums.Events.State.ForgerStarted, {
                activeDelegates: this.delegates.map(delegate => delegate.publicKey),
            });

            this.logger.info(`Forger Manager started.`);
        }

        this.initialized = true;
    }

    private checkLater(timeout: number): void {
        setTimeout(() => this.checkSlot(), timeout);
    }

    private printLoadedDelegates(): void {
        const activeDelegates: Delegate[] = this.delegates.filter(delegate =>
            this.usernames.hasOwnProperty(AppUtils.assert.defined(delegate.publicKey)),
        );

        if (activeDelegates.length > 0) {
            this.logger.info(
                `Loaded ${AppUtils.pluralize("active delegate", activeDelegates.length, true)}: ${activeDelegates
                    .map(({ publicKey }) => {
                        publicKey = AppUtils.assert.defined<string>(publicKey);

                        return `${this.usernames[publicKey]} (${publicKey})`;
                    })
                    .join(", ")}`,
            );
        }

        if (this.delegates.length > activeDelegates.length) {
            const inactiveDelegates: (string | undefined)[] = this.delegates
                .filter(delegate => !activeDelegates.includes(delegate))
                .map(delegate => delegate.publicKey);

            this.logger.info(
                `Loaded ${AppUtils.pluralize(
                    "inactive delegate",
                    inactiveDelegates.length,
                    true,
                )}: ${inactiveDelegates.join(", ")}`,
            );
        }
    }
}