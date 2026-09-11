import type { Address, Hex } from 'viem';
import { log } from './log.js';
import { RateLimitedError, type RpcPool } from './rpc.js';

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
  /** Upper bound the adaptive pacing may stretch to while an RPC throttles us. */
  maxPollIntervalMs?: number;
  /** Parallel block fetches during gap recovery. */
  backfillConcurrency?: number;
  isTarget: (address: Address) => boolean;
  onDetection: (detection: Detection) => void;
}

export class Watcher {
  private lastBlock = 0n;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = 0;
  private interval: number;
  blocksSeen = 0;
  blocksBackfilled = 0;
  blocksMissed = 0;
  throttleEvents = 0;
  lastBlockAt = 0;
  lastPollMs = 0;

  constructor(
    private readonly rpc: RpcPool,
    private readonly options: WatcherOptions,
  ) {
    this.interval = options.pollIntervalMs;
  }

  get pollIntervalMs(): number {
    return this.interval;
  }

  get head(): bigint {
    return this.lastBlock;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.lastBlock = BigInt(await this.rpc.race<Hex>('eth_blockNumber'));
      log.info(`watcher started at block ${this.lastBlock}`);
    } catch (error) {
      // A throttled or flaky endpoint at boot is recoverable: the first
      // successful poll adopts the head instead of killing the process.
      log.warn('could not read head at startup, will adopt it on first poll', (error as Error).message);
    }
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

  /**
   * Polling faster than the endpoint tolerates trades data for 429s, so the
   * cadence stretches while we are throttled and creeps back to the configured
   * interval as soon as the endpoint answers again.
   */
  private pace(throttled: boolean): void {
    const max = this.options.maxPollIntervalMs ?? 2000;
    if (throttled) {
      this.throttleEvents += 1;
      this.interval = Math.min(max, Math.max(this.options.pollIntervalMs, this.interval) * 2);
    } else if (this.interval > this.options.pollIntervalMs) {
      this.interval = Math.max(this.options.pollIntervalMs, this.interval * 0.8);
    }
  }

  private async tick(): Promise<void> {
    this.schedule(this.interval);
    if (this.inFlight >= (this.options.maxInFlight ?? 4)) return;
    this.inFlight += 1;
    const started = performance.now();
    try {
      const block = await this.rpc.race<RawBlock | null>('eth_getBlockByNumber', ['latest', true]);
      this.lastPollMs = performance.now() - started;
      this.pace(false);
      if (block) this.ingest(block, started);
    } catch (error) {
      const throttled = isThrottle(error);
      this.pace(throttled);
      if (throttled) log.debug('poll throttled', (error as Error).message);
      else log.warn('poll failed', (error as Error).message);
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
    const lanes = Math.max(1, this.options.backfillConcurrency ?? 4);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < numbers.length) {
        const number = numbers[cursor++]!;
        if (!(await this.fetchBlock(number))) {
          // One retry after the cooldown window: a gap block is only worth
          // copying for a few seconds, so we do not chase it forever.
          await sleep(this.interval);
          if (!(await this.fetchBlock(number))) this.blocksMissed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, numbers.length) }, worker));
  }

  private async fetchBlock(number: bigint): Promise<boolean> {
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
      return true;
    } catch (error) {
      if (isThrottle(error)) log.debug(`backfill of block ${number} throttled`);
      else log.warn(`backfill of block ${number} failed`, (error as Error).message);
      return false;
    }
  }
}

function isThrottle(error: unknown): boolean {
  return error instanceof RateLimitedError || /HTTP (429|503)/.test((error as Error)?.message ?? '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
