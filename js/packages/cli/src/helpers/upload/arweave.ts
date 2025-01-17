import * as anchor from '@project-serum/anchor';
import FormData from 'form-data';
import fs from 'fs';
import log from 'loglevel';
import fetch from 'node-fetch';
import { ARWEAVE_PAYMENT_WALLET } from '../constants';
import { sendTransactionWithRetryWithKeypair } from '../transactions';

export async function arweaveUpload(
    walletKeyPair,
    anchorProgram,
    env,
    image,
    manifestBuffer,
    manifest,
    index,
) {
    //const storageCost = 2300000; // 0.0023 SOL per file (paid to arweave)
    const storageCost = 20000;

    const instructions = [
        anchor.web3.SystemProgram.transfer({
            fromPubkey: walletKeyPair.publicKey,
            toPubkey: ARWEAVE_PAYMENT_WALLET,
            lamports: storageCost,
        }),
    ];

    const tx = await sendTransactionWithRetryWithKeypair(
        anchorProgram.provider.connection,
        walletKeyPair,
        instructions,
        [],
        'single',
    );

    const data = new FormData();
    data.append('transaction', tx['txid']);
    data.append('env', env);
    data.append('file[]', fs.createReadStream(image), {
        filename: `image.png`,
        contentType: 'image/png',
    });
    data.append('file[]', manifestBuffer, 'metadata.json');

    log.debug(`trying to upload ${index}.png: ${manifest.name}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, 10 * 1000);

    const response = await fetch(
        'https://us-central1-principal-lane-200702.cloudfunctions.net/uploadFile4',
        {
            method: 'POST',
            // @ts-ignore
            body: data,
            signal: controller.signal,
        },
    );

    const result = await response.json();

    const metadataFile = result.messages?.find(
        m => m.filename === 'manifest.json',
    );
    if (metadataFile?.transactionId) {
        const link = `https://arweave.net/${metadataFile.transactionId}`;
        log.debug(`File uploaded: ${link}`);
        return { link, payment: tx['txid'] };
    } else {
        // @todo improve
        throw new Error(`No transaction ID for upload: ${index}`);
    }
}
