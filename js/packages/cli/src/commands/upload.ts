import { EXTENSION_PNG } from '../helpers/constants';
import path from 'path';
import {
    createConfig,
    loadCandyProgram,
    loadWalletKey,
} from '../helpers/accounts';
import { PublicKey, Keypair } from '@solana/web3.js';
import fs from 'fs';
import BN from 'bn.js';
import { loadCache, saveCache } from '../helpers/cache';
import log from 'loglevel';
import { arweaveUpload } from '../helpers/upload/arweave';
import { ipfsCreds, ipfsUpload } from '../helpers/upload/ipfs';
import { chunks, sleep } from '../helpers/various';
import { CONFIG_ARRAY_START, CONFIG_LINE_SIZE } from '../helpers/constants';
import { doVerify } from '../candy-machine-cli';

async function uploadIndex(
    cacheContent: any,
    itemsRemaining: number,
    startIndex: number,
    anchorProgram: any,
    config: any,
    walletKeyPair: Keypair,
    cacheName: string,
    env: string,
) {
    const indexes = Array.from(
        { length: itemsRemaining },
        (v, k) => k + startIndex,
    );
    const onChain = indexes.filter(
        i => cacheContent.items[i]?.onChain || false,
    );

    if (indexes.length !== onChain.length) {
        console.log(
            `Writing indices ${startIndex} - ${
                itemsRemaining + startIndex - 1
            }`,
        );
    } else {
        return true;
    }

    if (!cacheContent.items[startIndex]) {
        console.log(`Item ${startIndex} does note exist in cache`);
        process.exit();
    }

    const indexContent = indexes.map(i => ({
        uri: cacheContent.items[i].link,
        name: cacheContent.items[i].name,
    }));

    try {
        const indicesTransaction = await anchorProgram.rpc.addConfigLines(startIndex, indexContent, {
            accounts: {
                config,
                authority: walletKeyPair.publicKey,
            },
            signers: [walletKeyPair],
        });

        for (const index of indexes) {
            cacheContent.items[index]!.onChain = true;
            cacheContent.items[index].indicesTransaction = `https://explorer.solana.com/tx/${indicesTransaction}?cluster=${env}`;
        }

        return true;
    } catch (err) {
        console.log(err);

        if (err.code === 303) {
            console.log('Recieved fatal error');
            process.exit();
        }

        return false;
    } finally {
        saveCache(cacheName, env, cacheContent);
    }
}

async function doUpload(
    anchorProgram: any,
    cacheName: string,
    env: string,
    keypair: string,
    totalNFTs: number,
    storage: string,
    retainAuthority: boolean,
    ipfsCredentials: ipfsCreds,
    cacheContent: any,
    walletKeyPair: Keypair,
    config: any,
    image: string,
    i: number,
) {
    const imageName = path.basename(image);
    const index = imageName.replace(EXTENSION_PNG, '');

    let link = cacheContent?.items?.[i]?.link;
    let payment;

    if (!link || !cacheContent.program.uuid) {
        const manifestPath = image.replace(EXTENSION_PNG, '.json');
        const manifestContent = fs
            .readFileSync(manifestPath)
            .toString()
            .replace(imageName, 'image.png')
            .replace(imageName, 'image.png');
        const manifest = JSON.parse(manifestContent);

        const manifestBuffer = Buffer.from(JSON.stringify(manifest));

        if (!link) {
            try {
                if (storage === 'arweave') {
                    const result = await arweaveUpload(
                        walletKeyPair,
                        anchorProgram,
                        env,
                        image,
                        manifestBuffer,
                        manifest,
                        index,
                    );
                    link = result.link;
                    payment = result.payment;
                } else if (storage === 'ipfs') {
                    link = await ipfsUpload(
                        ipfsCredentials,
                        image,
                        manifestBuffer,
                    );
                }

                if (link) {
                    cacheContent.items[index] = {
                        link,
                        name: manifest.name,
                        onChain: false,
                        payment: `https://explorer.solana.com/tx/${payment}?cluster=${env}`,
                    };
                    cacheContent.authority = walletKeyPair.publicKey.toBase58();
                    saveCache(cacheName, env, cacheContent);
                }
            } catch (er) {
                log.error(`Error uploading file ${index}`, er);
                return false;
            }
        }
    }

    return true;
}

export async function upload(
    files: string[],
    cacheName: string,
    env: string,
    keypair: string,
    totalNFTs: number,
    storage: string,
    retainAuthority: boolean,
    ipfsCredentials: ipfsCreds,
): Promise<boolean> {
    let uploadSuccessful = true;

    const savedContent = loadCache(cacheName, env);
    const cacheContent = savedContent || {};

    if (!cacheContent.program) {
        cacheContent.program = {};
    }

    let existingInCache = [];
    if (!cacheContent.items) {
        cacheContent.items = {};
    } else {
        existingInCache = Object.keys(cacheContent.items);
    }

    const seen = {};
    const newFiles = [];

    files.forEach(f => {
        if (!seen[f.replace(EXTENSION_PNG, '').split('/').pop()]) {
            seen[f.replace(EXTENSION_PNG, '').split('/').pop()] = true;
            newFiles.push(f);
        }
    });
    existingInCache.forEach(f => {
        if (!seen[f]) {
            seen[f] = true;
            newFiles.push(f + '.png');
        }
    });

    const images = newFiles
        .filter(val => path.extname(val) === EXTENSION_PNG)
        .sort(
            (a, b) =>
                Number(path.basename(a).replace('.png', '')) -
                Number(path.basename(b).replace('.png', '')),
        );
    const SIZE = images.length;

    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env);

    let config = cacheContent.program.config
        ? new PublicKey(cacheContent.program.config)
        : undefined;

    if (!cacheContent.program.uuid) {
        const manifestPath = images[0].replace(EXTENSION_PNG, '.json');
        const manifestContent = fs
            .readFileSync(manifestPath)
            .toString()
            .replace('0.png', 'image.png')
            .replace('0.png', 'image.png');
        const manifest = JSON.parse(manifestContent);

        try {
            const res = await createConfig(anchorProgram, walletKeyPair, {
                maxNumberOfLines: new BN(totalNFTs),
                symbol: manifest.symbol,
                sellerFeeBasisPoints: manifest.seller_fee_basis_points,
                isMutable: true,
                maxSupply: new BN(0),
                retainAuthority: retainAuthority,
                creators: manifest.properties.creators.map(creator => {
                    return {
                        address: new PublicKey(creator.address),
                        verified: true,
                        share: creator.share,
                    };
                }),
            });
            cacheContent.program.uuid = res.uuid;
            cacheContent.program.config = res.config.toBase58();
            config = res.config;

            log.info(
                `initialized config for a candy machine with publickey: ${res.config.toBase58()}`,
            );

            saveCache(cacheName, env, cacheContent);
        } catch (exx) {
            log.error('Error deploying config to Solana network.', exx);
            throw exx;
        }
    }

    const BATCH_SIZE = 9;

    for (let i = 0; i < SIZE / BATCH_SIZE; i++) {
        const itemsRemaining = Math.min(BATCH_SIZE, SIZE - i * BATCH_SIZE);

        while (true) {
            const processing = [];

            for (let j = 0; j < itemsRemaining; j++) {
                const item = i * BATCH_SIZE + j;

                console.log(
                    `[${new String(item + 1).padStart(5, ' ')} / ${totalNFTs}]`,
                );

                processing.push(
                    doUpload(
                        anchorProgram,
                        cacheName,
                        env,
                        keypair,
                        totalNFTs,
                        storage,
                        retainAuthority,
                        ipfsCredentials,
                        cacheContent,
                        walletKeyPair,
                        config,
                        images[item],
                        item,
                    ),
                );
            }

            console.log('Waiting for upload requests to complete...');

            const results = await Promise.all(processing);

            if (results.some(s => !s)) {
                console.log('Failed to upload images, retrying in 2 seconds');
                await sleep(2000);
                continue;
            }

            break;
        }

        const success = await uploadIndex(
            cacheContent,
            itemsRemaining,
            i * BATCH_SIZE,
            anchorProgram,
            config,
            walletKeyPair,
            cacheName,
            env,
        );

        if (!success) {
            uploadSuccessful = false;
        } else {
            let needAccountInfo = false;

            for (let j = 0; j < itemsRemaining; j++) {
                const item = i * BATCH_SIZE + j;
                const cacheItem = cacheContent.items[item];
                if (!cacheItem.verified) {
                    needAccountInfo = true;
                }
            }

            let configData;

            if (needAccountInfo) {
                while (true) {
                    const processing = [];

                    if (configData === undefined) {
                        console.log(
                            'Fetching uploaded config from candy machine...',
                        );

                        configData =
                            await anchorProgram.provider.connection.getAccountInfo(
                                config,
                            );
                    }

                    for (let j = 0; j < itemsRemaining; j++) {
                        const item = i * BATCH_SIZE + j;

                        const thisSlice = configData.data.slice(
                            CONFIG_ARRAY_START + 4 + CONFIG_LINE_SIZE * item,
                            CONFIG_ARRAY_START +
                                4 +
                                CONFIG_LINE_SIZE * (item + 1),
                        );

                        processing.push(
                            doVerify(item, thisSlice, cacheContent),
                        );
                    }

                    console.log(
                        'Waiting for verification requests to complete...',
                    );

                    try {
                        const results = await Promise.all(processing);

                        if (results.some(s => !s)) {
                            console.log(
                                'Failed to verify files! Will try again in 1 second.',
                            );
                            await sleep(1000 * 1);
                            continue;
                        }
                    } catch (err) {
                        console.log(err.toString());
                        console.log(
                            'Failed to verify files! Will try again in 1 seconds.',
                        );
                        await sleep(1000 * 1);
                        continue;
                    }

                    break;
                }

                saveCache(cacheName, env, cacheContent);
            } else {
                console.log('Skipping verification of already verified items');
            }
        }
    }

    console.log(`Done. Successful = ${uploadSuccessful}.`);

    return uploadSuccessful;
}
