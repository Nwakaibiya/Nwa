import { loadConfig } from '../src/config.js';
import { RpcPool } from '../src/rpc.js';

/**
 * Measures how quickly this host sees new blocks: the floor on copy latency.
 * Run it from Replit and from anywhere else you consider hosting.
 */
async function main(): Promise<void> {
  const config = loadConfig({ requireTelegram: false });
  const rpc = new RpcPool(config.rpcUrls, config.rpcTimeoutMs);
  const samples: number[] = [];
  const rtts: number[] = [];
  let last = 0n;
  let lastAt = 0;
  const started = Date.now();

  console.log(`polling ${config.rpcUrls.join(', ')} every ${config.pollIntervalMs}ms for 30s`);
  while (Date.now() - started < 30_000) {
    const t0 = performance.now();
    const block = await rpc
      .race<{ number: `0x${string}`; transactions: unknown[] } | null>('eth_getBlockByNumber', ['latest', true])
      .catch(() => null);
    rtts.push(performance.now() - t0);
    if (block) {
      const number = BigInt(block.number);
      if (number > last) {
        if (lastAt) samples.push(Date.now() - lastAt);
        last = number;
        lastAt = Date.now();
        console.log(`block ${number} · ${block.transactions.length} txs · rtt ${rtts.at(-1)!.toFixed(0)}ms`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  console.log(`\nblocks seen: ${samples.length + 1}`);
  console.log(`avg gap between blocks: ${avg(samples).toFixed(0)}ms`);
  console.log(`avg rpc round trip: ${avg(rtts).toFixed(0)}ms · best ${Math.min(...rtts).toFixed(0)}ms`);
}

void main();
