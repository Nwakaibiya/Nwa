import type { Address } from 'viem';
import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { Executor } from './executor.js';
import { startHealthServer } from './health.js';
import { log } from './log.js';
import { RpcPool } from './rpc.js';
import { Store } from './store.js';
import { createBot } from './telegram.js';
import { Watcher } from './watcher.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataFile);
  await store.load();

  const rpc = new RpcPool(config.rpcUrls, config.rpcTimeoutMs);
  const chainId = await rpc.race<`0x${string}`>('eth_chainId');
  if (Number(BigInt(chainId)) !== config.chain.id) {
    throw new Error(
      `RPC reports chainId ${Number(BigInt(chainId))} but config expects ${config.chain.id}. Fix CHAIN/CHAIN_ID/RPC_URLS.`,
    );
  }

  let executor: Executor | undefined;
  if (config.privateKey) {
    executor = new Executor(config.privateKey, rpc, config.chain.id);
    await executor.start(config.feeRefreshMs);
    log.info(`executor wallet ${executor.address}`);
  } else {
    store.updateSettings({ dryRun: true });
    log.warn('PRIVATE_KEY is not set — running in dry run only');
  }

  const notifyQueue: string[] = [];
  const engine = new Engine(store, rpc, config.chain, (message) => notifyQueue.push(message), executor);

  const watcher = new Watcher(rpc, {
    pollIntervalMs: config.pollIntervalMs,
    maxPollIntervalMs: config.maxPollIntervalMs,
    maxInFlight: config.maxInFlight,
    backfillConcurrency: config.backfillConcurrency,
    isTarget: (address: Address) => store.targets.some((target) => target.address === address),
    onDetection: (detection) => engine.handle(detection),
  });

  const bot = createBot(config.telegramToken, {
    store,
    engine,
    watcher,
    rpc,
    chain: config.chain,
    executor,
    ownerIds: config.ownerIds,
    pollIntervalMs: config.pollIntervalMs,
  });

  // Notifications are drained off the hot path so Telegram latency never
  // delays a broadcast.
  const drain = setInterval(() => {
    while (notifyQueue.length > 0) {
      const message = notifyQueue.shift()!;
      for (const ownerId of config.ownerIds) {
        void bot.api.sendMessage(ownerId, message).catch((error: Error) => {
          log.warn('telegram notify failed', error.message);
        });
      }
    }
  }, 150);
  drain.unref?.();

  const health = startHealthServer(Number(process.env.PORT ?? 3000), { watcher, engine, store });

  await watcher.start();
  void bot.start({
    onStart: () => log.info('telegram bot online'),
  });

  const shutdown = async () => {
    log.info('shutting down');
    watcher.stop();
    executor?.stop();
    clearInterval(drain);
    health.close();
    await bot.stop();
    await store.flush();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: Error) => {
  log.error(error.message);
  process.exit(1);
});
