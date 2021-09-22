import Router from 'koa-router';
import { formatTransaction, TransactionDB } from '../db/transaction';
import { DataDB } from '../db/data';
import { Utils } from '../utils/utils';
import { TransactionType } from '../faces/transaction';
import { Bundle } from 'arbundles';
import { WalletDB } from '../db/wallet';
import { b64UrlToBuffer, bufferTob64Url, hash } from '../utils/encoding';
import { ChunkDB } from '../db/chunks';

export const pathRegex = /^\/?([a-z0-9-_]{43})/i;

let transactionDB: TransactionDB;
let dataDB: DataDB;
let walletDB: WalletDB;
let chunkDB: ChunkDB;
let oldDbPath: string;

export async function txAnchorRoute(ctx: Router.RouterContext) {
  const txs = await ctx.connection.select('id').from('blocks').limit(1);
  if (txs.length) {
    return (ctx.body = txs[0].id);
  }
  ctx.body = Utils.randomID();
}

export async function txRoute(ctx: Router.RouterContext) {
  try {
    if (!transactionDB) {
      transactionDB = new TransactionDB(ctx.connection);
    }

    const path = ctx.params.txid.match(pathRegex) || [];
    const transaction = path.length > 1 ? path[1] : '';

    const metadata = await transactionDB.getById(transaction);
    ctx.logging.log(metadata);

    if (!metadata) {
      ctx.status = 404;
      ctx.body = { status: 404, error: 'Not Found' };
      return;
    }

    ctx.status = 200;
    ctx.headers['accept-ranges'] = 'bytes';
    ctx.headers['content-length'] = metadata.data_size;
    ctx.body = metadata;
  } catch (error) {
    console.error({ error });
  }
}

export async function txOffsetRoute(ctx: Router.RouterContext) {
  try {
    if (!transactionDB) {
      transactionDB = new TransactionDB(ctx.connection);
    }
    if (!chunkDB) {
      chunkDB = new ChunkDB(ctx.connection);
    }

    const path = ctx.params.txid.match(pathRegex) || [];
    const transaction = path.length > 1 ? path[1] : '';

    const metadata = await transactionDB.getById(transaction);
    ctx.logging.log(metadata);

    if (!metadata) {
      ctx.status = 404;
      ctx.body = { status: 404, error: 'Not Found' };
      return;
    }
    const chunk = await chunkDB.getByRootAndSize(metadata.data_root, metadata.data_size);

    ctx.status = 200;
    ctx.type = 'text/plain'; // TODO: updated this in arweave gateway to app/json
    ctx.body = { offset: +chunk.offset, size: metadata.data_size };
  } catch (error) {
    console.error({ error });
  }
}

export async function txPostRoute(ctx: Router.RouterContext) {
  try {
    if (oldDbPath !== ctx.dbPath || !dataDB || !walletDB) {
      dataDB = new DataDB(ctx.dbPath);
      walletDB = new WalletDB(ctx.connection);
      oldDbPath = ctx.dbPath;
    }
    const data = ctx.request.body as unknown as TransactionType;

    ctx.logging.log('post', data);

    let bundleFormat = '';
    let bundleVersion = '';

    for (const tag of data.tags) {
      const name = Utils.atob(tag.name);
      const value = Utils.atob(tag.value);

      if (name === 'Bundle-Format') bundleFormat = value;
      if (name === 'Bundle-Version') bundleVersion = value;
    }

    if (bundleFormat === 'binary' && bundleVersion === '2.0.0') {
      // ANS-104

      const buffer = Buffer.from(data.data, 'base64');

      const bundle = new Bundle(buffer);

      const items = bundle.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        await txPostRoute({
          ...ctx,
          connection: ctx.connection,
          logging: ctx.logging,
          network: ctx.network,
          request: {
            ...ctx.request,
            body: {
              id: bundle.getIdBy(i),
              ...item.toJSON(),
            },
          },
        });
      }
    }

    const owner = bufferTob64Url(await hash(b64UrlToBuffer(data.owner)));

    // BALANCE UPDATES
    if (data?.target && data?.quantity) {
      const fromWallet = await walletDB.getWallet(owner);
      const targetWallet = await walletDB.getWallet(data.target);

      if (!fromWallet || !targetWallet) {
        ctx.status = 404;
        ctx.body = { status: 404, error: `Wallet not found` };
        return;
      }
      if (fromWallet?.balance < +data.quantity + +data.reward) {
        ctx.status = 403;
        ctx.body = { status: 403, error: `you don't have enough funds to send ${data.quantity}` };
        return;
      }
      await walletDB.incrementBalance(data.target, +data.quantity);
      await walletDB.incrementBalance(data.owner, -data.quantity);
    }

    await walletDB.incrementBalance(data.owner, -data.reward);

    await dataDB.insert({ txid: data.id, data: data.data });

    const tx = formatTransaction(data);

    tx.height = ctx.network.blocks;

    await ctx.connection.insert(tx).into('transactions');

    let index = 0;
    for (const tag of data.tags) {
      const name = Utils.atob(tag.name);
      const value = Utils.atob(tag.value);

      ctx.logging.log(name, value);

      await ctx.connection
        .insert({
          index,
          tx_id: tx.id,
          name,
          value,
        })
        .into('tags');

      index++;
    }

    ctx.body = data;
  } catch (error) {
    console.error({ error });
  }
}
