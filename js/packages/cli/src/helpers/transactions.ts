import {
    Blockhash,
    Commitment,
    Connection,
    FeeCalculator,
    Keypair,
    RpcResponseAndContext,
    SignatureStatus,
    SignatureResult,
    Context,
    SimulatedTransactionResponse,
    Transaction,
    TransactionInstruction,
    TransactionSignature,
} from '@solana/web3.js';
import { getUnixTs, sleep } from './various';
import { DEFAULT_TIMEOUT } from './constants';
import log from 'loglevel';

interface BlockhashAndFeeCalculator {
    blockhash: Blockhash;
    feeCalculator: FeeCalculator;
}

export const sendTransactionWithRetryWithKeypair = async (
    connection: Connection,
    wallet: Keypair,
    instructions: TransactionInstruction[],
    signers: Keypair[],
    commitment: Commitment = 'singleGossip',
    includesFeePayer: boolean = false,
    block?: BlockhashAndFeeCalculator,
    beforeSend?: () => void,
) => {
    const transaction = new Transaction();
    instructions.forEach(instruction => transaction.add(instruction));
    transaction.recentBlockhash = (
        block || (await connection.getRecentBlockhash(commitment))
    ).blockhash;

    if (includesFeePayer) {
        transaction.setSigners(...signers.map(s => s.publicKey));
    } else {
        transaction.setSigners(
            // fee payed by the wallet owner
            wallet.publicKey,
            ...signers.map(s => s.publicKey),
        );
    }

    if (signers.length > 0) {
        transaction.sign(...[wallet, ...signers]);
    } else {
        transaction.sign(wallet);
    }

    if (beforeSend) {
        beforeSend();
    }

    const { txid, slot } = await sendSignedTransaction({
        connection,
        signedTransaction: transaction,
    });

    return { txid, slot };
};

export async function sendSignedTransaction({
    signedTransaction,
    connection,
    timeout = DEFAULT_TIMEOUT,
}: {
    signedTransaction: Transaction;
    connection: Connection;
    sendingMessage?: string;
    sentMessage?: string;
    successMessage?: string;
    timeout?: number;
}): Promise<{ txid: string; slot: number }> {
    const rawTransaction = signedTransaction.serialize();
    const startTime = getUnixTs();
    let slot = 0;
    const txid: TransactionSignature = await connection.sendRawTransaction(
        rawTransaction,
        {
            skipPreflight: true,
        },
    );

    log.debug('Started awaiting confirmation for', txid);

    let done = false;
    (async () => {
        while (!done && getUnixTs() - startTime < timeout) {
            connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
            });
            await sleep(500);
        }
    })();
    try {
        const confirmation = await awaitTransactionSignatureConfirmation(
            txid,
            timeout,
            connection,
            'recent',
        );

        if (!confirmation)
            throw new Error('Timed out awaiting confirmation on transaction');

        if (confirmation.err) {
            log.error(confirmation.err);
            throw new Error('Transaction failed: Custom instruction error');
        }

        slot = confirmation?.slot || 0;
    } catch (err) {
        log.error('Timeout Error caught', err);
        if (err.timeout) {
            throw new Error('Timed out awaiting confirmation on transaction');
        }
        let simulateResult: SimulatedTransactionResponse | null = null;
        try {
            simulateResult = (
                await simulateTransaction(
                    connection,
                    signedTransaction,
                    'single',
                )
            ).value;
        } catch (e) {
            log.error('Simulate Transaction error', e);
        }
        if (simulateResult && simulateResult.err) {
            if (simulateResult.logs) {
                for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
                    const line = simulateResult.logs[i];
                    if (line.startsWith('Program log: ')) {
                        throw new Error(
                            'Transaction failed: ' +
                                line.slice('Program log: '.length),
                        );
                    }
                }
            }
            throw new Error(JSON.stringify(simulateResult.err));
        }
        // throw new Error('Transaction failed');
    } finally {
        done = true;
    }

    return { txid, slot };
}

async function simulateTransaction(
    connection: Connection,
    transaction: Transaction,
    commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    // @ts-ignore
    transaction.recentBlockhash = await connection._recentBlockhash(
        // @ts-ignore
        connection._disableBlockhashCaching,
    );

    const signData = transaction.serializeMessage();
    // @ts-ignore
    const wireTransaction = transaction._serialize(signData);
    const encodedTransaction = wireTransaction.toString('base64');
    const config: any = { encoding: 'base64', commitment };
    const args = [encodedTransaction, config];

    // @ts-ignore
    const res = await connection._rpcRequest('simulateTransaction', args);
    if (res.error) {
        throw new Error('failed to simulate transaction: ' + res.error.message);
    }
    return res.result;
}

async function awaitTransactionSignatureConfirmation(
    txid: TransactionSignature,
    timeout: number,
    connection: Connection,
    commitment: Commitment = 'recent',
): Promise<SignatureStatus | null | void> {
    let outOfTime = false;

    setTimeout(() => {
        outOfTime = true;
    }, timeout);

    while (true) {
        await sleep(1000);

        const sigStatus = await connection.getSignatureStatuses([txid]);

        if (sigStatus && sigStatus.value[0]) {
            return sigStatus.value[0];
        }

        if (outOfTime) {
            return null;
        }

        console.log(`Failed to get signature status for ${txid}, retrying in 2 seconds...`);

        await sleep(1000);
    }
}
