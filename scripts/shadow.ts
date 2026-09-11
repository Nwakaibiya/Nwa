import type { Address, Hex } from 'viem';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { RpcPool } from '../src/rpc.js';
import { Store } from '../src/store.js';
import { Watcher, type RawTx } from '../src/watcher.js';

/**
 * End-to-end dry run against the live chain: picks the busiest senders in the
 * current head block, watches them, and prints every decision the engine makes.
 *
 *   npm run shadow -- [seconds] [address ...]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seconds = Number(args[0] ?? 45);
  const explicit = args.slice(1).map((value) => value.toLowerCase() as Address);

  const config = loadConfig({ requireTelegram: false });
  const rpc = new RpcPool(config.rpcUrls, config.rpcTimeoutMs);
  const store = new Store('data/shadow.json');
  await store.load();
  store.updateSettings({ dryRun: true, paused: false, notifySkips: true });
  for (const target of [...store.targets]) store.removeTarget(target.address);

  const targets = explicit.length > 0 ? explicit : await busiestSenders(rpc, 4);
  for (const address of targets) {
    store.addTarget({ address, label: 'shadow', addedAt: Date.now(), enabled: true });
  }
  console.log(`watching ${targets.length} wallets on ${config.chain.name}:`);
  for (const address of targets) console.log(`  ${address}`);

  const engine = new Engine(store, rpc, config.chain, (message) => console.log(`\n${message}\n`), undefined);
  const watcher = new Watcher(rpc, {
    pollIntervalMs: config.pollIntervalMs,
    maxInFlight: config.maxInFlight,
    isTarget: (address) => store.targets.some((target) => target.address === address),
    onDetection: (detection) => engine.handle(detection),
  });

  await watcher.start();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  watcher.stop();

  console.log('\n--- shadow run summary ---');
  console.log(`blocks seen live: ${watcher.blocksSeen} · backfilled: ${watcher.blocksBackfilled}`);
  console.log(`last poll rtt: ${watcher.lastPollMs.toFixed(0)}ms`);
  console.log('engine stats:', engine.stats);
  await store.flush();
  process.exit(0);
}

async function busiestSenders(rpc: RpcPool, count: number): Promise<Address[]> {
  const head = await rpc.race<Hex>('eth_blockNumber');
  const numbers = Array.from({ length: 5 }, (_, index) => BigInt(head) - BigInt(index));
  const blocks = await Promise.all(
    numbers.map((number) =>
      rpc.call<{ transactions: RawTx[] } | null>('eth_getBlockByNumber', [`0x${number.toString(16)}`, true]),
    ),
  );
  const counts = new Map<Address, number>();
  for (const block of blocks) {
    for (const tx of block?.transactions ?? []) {
      if (!tx.from || !tx.to || tx.input === '0x') continue;
      const from = tx.from.toLowerCase() as Address;
      counts.set(from, (counts.get(from) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([address]) => address);
}

void main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
