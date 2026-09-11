import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import { log } from './log.js';

export type DetectionMode = 'fast' | 'verified';

export interface TargetWallet {
  address: Address;
  label: string;
  addedAt: number;
  enabled: boolean;
  copies?: number;
  maxValueWei?: string;
}

export interface Settings {
  detectionMode: DetectionMode;
  dryRun: boolean;
  paused: boolean;
  copies: number;
  /** Multiplier applied to the target's msg.value, in basis points (10000 = exact copy). */
  valueBps: number;
  maxValueWeiPerTx: string;
  dailyCapWei: string;
  gasLimitBps: number;
  priorityFeeBps: number;
  maxFeeBps: number;
  minPriorityFeeWei: string;
  cooldownSecPerTarget: number;
  contractAllowlist: Address[];
  contractDenylist: Address[];
  rewriteRecipient: boolean;
  notifySkips: boolean;
}

export interface TradeRecord {
  at: number;
  target: Address;
  contract: Address;
  targetTxHash: string;
  ourTxHash?: string;
  valueWei: string;
  latencyMs: number;
  status: 'sent' | 'confirmed' | 'reverted' | 'failed' | 'dry-run';
  error?: string;
}

export interface State {
  targets: TargetWallet[];
  settings: Settings;
  trades: TradeRecord[];
}

export const DEFAULT_SETTINGS: Settings = {
  detectionMode: 'fast',
  dryRun: true,
  paused: false,
  copies: 1,
  valueBps: 10_000,
  maxValueWeiPerTx: '100000000000000000',
  dailyCapWei: '1000000000000000000',
  gasLimitBps: 13_000,
  priorityFeeBps: 20_000,
  maxFeeBps: 20_000,
  minPriorityFeeWei: '10000000',
  cooldownSecPerTarget: 0,
  contractAllowlist: [],
  contractDenylist: [],
  rewriteRecipient: true,
  notifySkips: false,
};

const MAX_TRADES = 500;

export class Store {
  private state: State = { targets: [], settings: { ...DEFAULT_SETTINGS }, trades: [] };
  private writeTimer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<State>;
      this.state = {
        targets: parsed.targets ?? [],
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
        trades: parsed.trades ?? [],
      };
      log.info(`state loaded from ${this.file}`, { targets: this.state.targets.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      log.info(`no existing state at ${this.file}, starting fresh`);
      await this.flush();
    }
  }

  get settings(): Settings {
    return this.state.settings;
  }

  get targets(): TargetWallet[] {
    return this.state.targets;
  }

  get trades(): TradeRecord[] {
    return this.state.trades;
  }

  findTarget(address: Address): TargetWallet | undefined {
    return this.state.targets.find((target) => target.address === address);
  }

  addTarget(target: TargetWallet): boolean {
    if (this.findTarget(target.address)) return false;
    this.state.targets.push(target);
    this.persist();
    return true;
  }

  removeTarget(address: Address): boolean {
    const before = this.state.targets.length;
    this.state.targets = this.state.targets.filter((target) => target.address !== address);
    if (this.state.targets.length === before) return false;
    this.persist();
    return true;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.state.settings = { ...this.state.settings, ...patch };
    this.persist();
  }

  recordTrade(trade: TradeRecord): void {
    this.state.trades.unshift(trade);
    if (this.state.trades.length > MAX_TRADES) this.state.trades.length = MAX_TRADES;
    this.persist();
  }

  updateTrade(targetTxHash: string, patch: Partial<TradeRecord>): void {
    const trade = this.state.trades.find((entry) => entry.targetTxHash === targetTxHash);
    if (!trade) return;
    Object.assign(trade, patch);
    this.persist();
  }

  spentInLast24h(): bigint {
    const cutoff = Date.now() - 86_400_000;
    return this.state.trades
      .filter((trade) => trade.at >= cutoff && trade.status !== 'dry-run' && trade.status !== 'failed')
      .reduce((total, trade) => total + BigInt(trade.valueWei), 0n);
  }

  /** Debounced so a burst of mints never blocks the hot path on disk IO. */
  persist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.writing = this.flush().catch((error) => log.error('state persist failed', (error as Error).message));
    }, 250);
    this.writeTimer.unref?.();
  }

  async flush(): Promise<void> {
    await this.writing;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }
}
