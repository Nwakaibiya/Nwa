import { type Address, type Chain, type Hex, formatEther } from 'viem';
import { looksAllowlistGated, rewriteRecipient, scaleValue } from './calldata.js';
import { classify, mintedCollections, type ReceiptLog } from './detect.js';
import type { Executor } from './executor.js';
import { log } from './log.js';
import type { RpcPool } from './rpc.js';
import type { Store, TradeRecord } from './store.js';
import type { Detection } from './watcher.js';

export type Notifier = (message: string) => void;

interface TargetReceipt {
  status: Hex;
  logs: ReceiptLog[];
}

export interface EngineStats {
  detections: number;
  copies: number;
  skips: number;
  failures: number;
  lastLatencyMs: number;
  bestLatencyMs: number;
}

export class Engine {
  readonly stats: EngineStats = {
    detections: 0,
    copies: 0,
    skips: 0,
    failures: 0,
    lastLatencyMs: 0,
    bestLatencyMs: Number.POSITIVE_INFINITY,
  };

  private readonly lastFireAt = new Map<Address, number>();
  private readonly handled = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly rpc: RpcPool,
    private readonly chain: Chain,
    private readonly notify: Notifier,
    private executor: Executor | undefined,
  ) {}

  setExecutor(executor: Executor | undefined): void {
    this.executor = executor;
  }

  explorerTx(hash: string): string {
    const base = this.chain.blockExplorers?.default.url;
    return base ? `${base}/tx/${hash}` : hash;
  }

  handle(detection: Detection): void {
    if (this.handled.has(detection.tx.hash)) return;
    this.handled.add(detection.tx.hash);
    if (this.handled.size > 5_000) this.handled.clear();
    this.stats.detections += 1;
    void this.process(detection).catch((error) => {
      this.stats.failures += 1;
      log.error('copy failed', (error as Error).message);
      this.notify(`⚠️ Copy failed for ${detection.tx.hash}: ${(error as Error).message}`);
    });
  }

  private skip(reason: string, detection: Detection): void {
    this.stats.skips += 1;
    log.debug(`skip ${detection.tx.hash}: ${reason}`);
    if (this.store.settings.notifySkips) {
      this.notify(`⏭ Skipped ${short(detection.tx.hash)} — ${reason}`);
    }
  }

  private async process(detection: Detection): Promise<void> {
    const settings = this.store.settings;
    const tx = detection.tx;
    const target = this.store.findTarget(tx.from.toLowerCase() as Address);
    if (!target || !target.enabled) return;
    if (settings.paused) return this.skip('bot paused', detection);

    const to = tx.to?.toLowerCase() as Address | undefined;
    if (!to) return this.skip('contract deployment', detection);
    if (settings.contractDenylist.includes(to)) return this.skip('contract denylisted', detection);
    if (settings.contractAllowlist.length > 0 && !settings.contractAllowlist.includes(to)) {
      return this.skip('contract not in allowlist', detection);
    }

    const value = BigInt(tx.value);
    const verdict = classify({ to, input: tx.input, value });
    if (verdict.kind === 'skip') return this.skip(verdict.reason, detection);
    if (verdict.kind === 'maybe-mint' && verdict.reason === 'unknown-selector' && value === 0n) {
      if (settings.detectionMode === 'fast') return this.skip('unknown zero-value call', detection);
    }

    if (settings.detectionMode === 'verified') {
      const confirmed = await this.confirmMint(tx.hash, tx.from.toLowerCase() as Address);
      if (!confirmed) return this.skip('no NFT mint in receipt', detection);
    }

    if (looksAllowlistGated(tx.input)) {
      return this.skip('allowlist/merkle-gated mint — proof would not match our wallet', detection);
    }

    const cooldownMs = settings.cooldownSecPerTarget * 1000;
    const lastFire = this.lastFireAt.get(target.address) ?? 0;
    if (cooldownMs > 0 && Date.now() - lastFire < cooldownMs) {
      return this.skip('target cooldown active', detection);
    }

    const ourValue = scaleValue(value, settings.valueBps);
    const perTxCap = BigInt(target.maxValueWei ?? settings.maxValueWeiPerTx);
    if (ourValue > perTxCap) {
      return this.skip(`value ${formatEther(ourValue)} above cap ${formatEther(perTxCap)}`, detection);
    }

    const copies = Math.max(1, target.copies ?? settings.copies);
    const totalValue = ourValue * BigInt(copies);
    const dailyCap = BigInt(settings.dailyCapWei);
    if (this.store.spentInLast24h() + totalValue > dailyCap) {
      return this.skip('24h spend cap reached', detection);
    }

    const gasLimit = (BigInt(tx.gas) * BigInt(settings.gasLimitBps)) / 10_000n;
    const executor = this.executor;

    if (settings.dryRun || !executor) {
      const latency = performance.now() - detection.seenAt;
      this.record(detection, target.address, to, ourValue, latency, 'dry-run');
      this.notify(
        [
          `🧪 DRY RUN — would copy mint`,
          `Target: ${target.label || short(target.address)}`,
          `Contract: ${short(to)}`,
          `Value: ${formatEther(ourValue)} ${this.chain.nativeCurrency.symbol} × ${copies}`,
          `Gas limit: ${gasLimit}`,
          `Detected in ${latency.toFixed(0)}ms`,
          this.explorerTx(tx.hash),
        ].join('\n'),
      );
      return;
    }

    this.lastFireAt.set(target.address, Date.now());
    const rewrite = settings.rewriteRecipient
      ? rewriteRecipient(tx.input, tx.from.toLowerCase() as Address, executor.address)
      : { data: tx.input, replacements: 0 };

    for (let copy = 0; copy < copies; copy += 1) {
      const result = await executor.send({
        to,
        data: rewrite.data,
        value: ourValue,
        gasLimit,
        priorityFeeBps: settings.priorityFeeBps,
        maxFeeBps: settings.maxFeeBps,
        minPriorityFeeWei: BigInt(settings.minPriorityFeeWei),
        copies,
      });
      const latency = performance.now() - detection.seenAt;
      this.stats.copies += 1;
      this.stats.lastLatencyMs = latency;
      this.stats.bestLatencyMs = Math.min(this.stats.bestLatencyMs, latency);
      this.record(detection, target.address, to, ourValue, latency, 'sent', result.hash);
      this.notify(
        [
          `⚡️ Copy mint sent (${copy + 1}/${copies})`,
          `Target: ${target.label || short(target.address)}`,
          `Contract: ${short(to)}`,
          `Value: ${formatEther(ourValue)} ${this.chain.nativeCurrency.symbol}`,
          `Recipient rewrites: ${rewrite.replacements}`,
          `Latency: ${latency.toFixed(0)}ms (sign ${result.signMs.toFixed(0)}ms, send ${result.broadcastMs.toFixed(0)}ms)`,
          this.explorerTx(result.hash),
        ].join('\n'),
      );
      void this.trackReceipt(executor, tx.hash, result.hash);
    }
  }

  private async confirmMint(hash: Hex, minter: Address): Promise<boolean> {
    const receipt = await this.rpc.race<TargetReceipt | null>('eth_getTransactionReceipt', [hash]);
    if (!receipt || receipt.status !== '0x1') return false;
    return mintedCollections(receipt.logs ?? [], minter).length > 0;
  }

  private async trackReceipt(executor: Executor, targetHash: Hex, ourHash: Hex): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(750);
      const receipt = await executor.receipt(ourHash).catch(() => null);
      if (!receipt) continue;
      const ok = receipt.status === '0x1';
      this.store.updateTrade(targetHash, { status: ok ? 'confirmed' : 'reverted' });
      this.notify(
        ok
          ? `✅ Mint confirmed ${this.explorerTx(ourHash)}`
          : `❌ Mint reverted ${this.explorerTx(ourHash)}`,
      );
      return;
    }
  }

  private record(
    detection: Detection,
    target: Address,
    contract: Address,
    valueWei: bigint,
    latencyMs: number,
    status: TradeRecord['status'],
    ourTxHash?: string,
  ): void {
    this.store.recordTrade({
      at: Date.now(),
      target,
      contract,
      targetTxHash: detection.tx.hash,
      ourTxHash,
      valueWei: valueWei.toString(),
      latencyMs: Math.round(latencyMs),
      status,
    });
  }
}

export function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
