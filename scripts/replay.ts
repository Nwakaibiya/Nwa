import type { Address, Hex } from 'viem';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { RpcPool } from '../src/rpc.js';
import { Store } from '../src/store.js';
import type { RawTx } from '../src/watcher.js';

/**
 * Replays a historical transaction through the full decision pipeline in dry
 * run: the honest way to check detection and calldata rewriting against a real
 * mint before any money is at risk.
 *
 *   npm run replay -- 0x<tx hash> [fast|verified]
 */
async function main(): Promise<void> {
  const hash = process.argv[2] as Hex | undefined;
  if (!hash?.startsWith('0x')) throw new Error('usage: npm run replay -- <tx hash> [fast|verified]');
  const mode = process.argv[3] === 'verified' ? 'verified' : 'fast';

  const config = loadConfig({ requireTelegram: false });
  const rpc = new RpcPool(config.rpcUrls, config.rpcTimeoutMs);
  const store = new Store(config.dataFile);
  await store.load();

  const tx = await rpc.call<RawTx | null>('eth_getTransactionByHash', [hash]);
  if (!tx) throw new Error(`transaction ${hash} not found on ${config.chain.name}`);

  const from = tx.from.toLowerCase() as Address;
  const existing = store.findTarget(from);
  if (!existing) {
    store.addTarget({ address: from, label: 'replay', addedAt: Date.now(), enabled: true });
  }
  store.updateSettings({ dryRun: true, paused: false, notifySkips: true, detectionMode: mode });

  const engine = new Engine(store, rpc, config.chain, (message) => console.log(`\n${message}`), undefined);
  engine.handle({ tx, blockNumber: 0n, seenAt: performance.now() });

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  console.log('\nstats', engine.stats);
  if (!existing) store.removeTarget(from);
  await store.flush();
}

void main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
