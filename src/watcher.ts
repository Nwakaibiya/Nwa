import type { Address, Hex } from 'viem';
import { log } from './log.js';
import type { RpcPool } from './rpc.js';

export interface RawTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: Hex;
  gas: Hex;
  nonce: Hex;
}

interface RawBlock {
  number: Hex;
  timestamp: Hex;
  transactions: RawTx[];
}

export interface Detection {
  tx: RawTx;
  blockNumber: bigint;
  /** performance.now() of the moment the block landed in this process. */
  seenAt: number;
}

export interface WatcherOptions {
  pollIntervalMs: number;
  /**
   * Nitro chains produce blocks faster than a single round trip completes, so
   * several polls stay in flight at once and the head is sampled every
   * pollIntervalMs regardless of RPC latency.
   */
  maxInFlight?: number;
  isTarget: (address: Address) => boolean;
  onDetection: (detection: Detection) => void;
}

export class Watcher {
  private lastBlock = 0n;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = 0;
  blocksSeen = 0;
  blocksBackfilled = 0;
  lastBlockAt = 0;
  lastPollMs = 0;

  constructor(
    private readonly rpc: RpcPool,
    private readonly options: WatcherOptions,
  ) {}

  get head(): bigint {
    return this.lastBlock;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const head = await this.rpc.race<Hex>('eth_blockNumber');
    this.lastBlock = BigInt(head);
    log.info(`watcher started at block ${this.lastBlock}`);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.schedule(this.options.pollIntervalMs);
    if (this.inFlight >= (this.options.maxInFlight ?? 4)) return;
    this.inFlight += 1;
    const started = performance.now();
    try {
      const block = await this.rpc.race<RawBlock | null>('eth_getBlockByNumber', ['latest', true]);
      this.lastPollMs = performance.now() - started;
      if (block) this.ingest(block, started);
    } catch (error) {
      log.warn('poll failed', (error as Error).message);
    } finally {
      this.inFlight -= 1;
    }
  }

  private ingest(block: RawBlock, seenAt: number): void {
    const number = BigInt(block.number);
    if (number <= this.lastBlock) return;
    if (this.lastBlock > 0n && number > this.lastBlock + 1n) {
      void this.backfill(this.lastBlock + 1n, number - 1n);
    }
    this.lastBlock = number;
    this.blocksSeen += 1;
    this.lastBlockAt = Date.now();
    this.scan(block, number, seenAt);
  }

  private scan(block: RawBlock, number: bigint, seenAt: number): void {
    for (const tx of block.transactions) {
      if (!tx.from) continue;
      if (!this.options.isTarget(tx.from.toLowerCase() as Address)) continue;
      this.options.onDetection({ tx, blockNumber: number, seenAt });
    }
  }

  /**
   * Blocks produced between two polls still contain mints worth copying, so
   * they are fetched in parallel rather than one after another.
   */
  private async backfill(from: bigint, to: bigint): Promise<void> {
    const span = Number(to - from) + 1;
    if (span > 100) {
      log.warn(`skipping backfill of ${span} blocks`);
      return;
    }
    const numbers: bigint[] = [];
    for (let number = from; number <= to; number += 1n) numbers.push(number);
    await Promise.all(
      numbers.map(async (number) => {
        const seenAt = performance.now();
        try {
          const block = await this.rpc.call<RawBlock | null>('eth_getBlockByNumber', [
            `0x${number.toString(16)}`,
            true,
          ]);
          if (block) {
            this.blocksBackfilled += 1;
            this.scan(block, number, seenAt);
          }
        } catch (error) {
          log.warn(`backfill of block ${number} failed`, (error as Error).message);
        }
      }),
    );
  }
}
