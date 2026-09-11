import type { Address, Hex, PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { log } from './log.js';
import { JsonRpcError, type RpcPool } from './rpc.js';

export interface FeeSnapshot {
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
  updatedAt: number;
}

export interface CopyRequest {
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  priorityFeeBps: number;
  maxFeeBps: number;
  minPriorityFeeWei: bigint;
  copies: number;
}

export interface SendResult {
  hash: Hex;
  nonce: number;
  signMs: number;
  broadcastMs: number;
}

export class Executor {
  readonly account: PrivateKeyAccount;
  private nonce = -1;
  private nonceLock: Promise<void> = Promise.resolve();
  private fees: FeeSnapshot = { baseFeePerGas: 0n, priorityFeePerGas: 0n, updatedAt: 0 };
  private feeTimer: NodeJS.Timeout | undefined;

  constructor(
    privateKey: Hex,
    private readonly rpc: RpcPool,
    private readonly chainId: number,
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address.toLowerCase() as Address;
  }

  get feeSnapshot(): FeeSnapshot {
    return this.fees;
  }

  /**
   * Nonce and gas price are refreshed out of band: the hot path must never
   * spend a round trip discovering state it could already know.
   */
  async start(feeRefreshMs: number): Promise<void> {
    await Promise.all([this.syncNonce(), this.refreshFees()]);
    this.feeTimer = setInterval(() => void this.refreshFees(), feeRefreshMs);
    this.feeTimer.unref?.();
  }

  stop(): void {
    if (this.feeTimer) clearInterval(this.feeTimer);
  }

  async syncNonce(): Promise<number> {
    const raw = await this.rpc.call<Hex>('eth_getTransactionCount', [this.account.address, 'pending']);
    this.nonce = Number(BigInt(raw));
    return this.nonce;
  }

  async refreshFees(): Promise<void> {
    try {
      const [block, priority] = await Promise.all([
        this.rpc.call<{ baseFeePerGas: Hex | null }>('eth_getBlockByNumber', ['latest', false]),
        this.rpc
          .call<Hex>('eth_maxPriorityFeePerGas')
          .catch(() => '0x0' as Hex),
      ]);
      this.fees = {
        baseFeePerGas: block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n,
        priorityFeePerGas: BigInt(priority),
        updatedAt: Date.now(),
      };
    } catch (error) {
      log.warn('fee refresh failed', (error as Error).message);
    }
  }

  async balance(): Promise<bigint> {
    const raw = await this.rpc.call<Hex>('eth_getBalance', [this.account.address, 'latest']);
    return BigInt(raw);
  }

  private nextNonce(): number {
    if (this.nonce < 0) throw new Error('nonce not initialised');
    return this.nonce++;
  }

  /** Serialises nonce allocation so parallel copies never collide. */
  private async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const previous = this.nonceLock;
    this.nonceLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn(this.nextNonce());
    } finally {
      release();
    }
  }

  async send(request: CopyRequest): Promise<SendResult> {
    return this.withNonce(async (nonce) => {
      const priorityFee = maxBigint(
        (this.fees.priorityFeePerGas * BigInt(request.priorityFeeBps)) / 10_000n,
        request.minPriorityFeeWei,
      );
      const maxFee =
        (this.fees.baseFeePerGas * BigInt(request.maxFeeBps)) / 10_000n + priorityFee;

      const signStart = performance.now();
      const serialized = await this.account.signTransaction({
        chainId: this.chainId,
        type: 'eip1559',
        to: request.to,
        data: request.data,
        value: request.value,
        gas: request.gasLimit,
        nonce,
        maxFeePerGas: maxFee > 0n ? maxFee : priorityFee,
        maxPriorityFeePerGas: priorityFee,
      });
      const signMs = performance.now() - signStart;

      const broadcastStart = performance.now();
      try {
        const hash = await this.rpc.broadcast(serialized);
        return { hash, nonce, signMs, broadcastMs: performance.now() - broadcastStart };
      } catch (error) {
        if (error instanceof JsonRpcError && /nonce/i.test(error.message)) {
          await this.syncNonce();
        }
        throw error;
      }
    });
  }

  /** Kept for the optional pre-flight in verified mode; never used on the hot path. */
  async simulate(request: Pick<CopyRequest, 'to' | 'data' | 'value'>): Promise<void> {
    await this.rpc.call('eth_call', [
      {
        from: this.account.address,
        to: request.to,
        data: request.data,
        value: `0x${request.value.toString(16)}`,
      },
      'latest',
    ]);
  }

  async receipt(hash: Hex): Promise<{ status: Hex; gasUsed: Hex } | null> {
    return this.rpc.call<{ status: Hex; gasUsed: Hex } | null>('eth_getTransactionReceipt', [hash]);
  }
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
