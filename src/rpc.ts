import { Agent, setGlobalDispatcher } from 'undici';
import { log } from './log.js';

/**
 * Keep-alive pooling: a cold TLS handshake costs more than a whole poll cycle,
 * so every endpoint keeps warm sockets for the lifetime of the process.
 */
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 64,
    pipelining: 1,
  }),
);

export interface RpcError {
  code: number;
  message: string;
}

export class JsonRpcError extends Error {
  readonly code: number;

  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
    this.name = 'JsonRpcError';
  }
}

interface EndpointStats {
  url: string;
  wins: number;
  calls: number;
  errors: number;
  lastLatencyMs: number;
}

export class RpcPool {
  private id = 0;
  private cursor = 0;
  readonly stats: EndpointStats[];

  constructor(
    readonly urls: string[],
    private readonly timeoutMs = 4000,
  ) {
    if (urls.length === 0) throw new Error('RpcPool requires at least one endpoint');
    this.stats = urls.map((url) => ({ url, wins: 0, calls: 0, errors: 0, lastLatencyMs: 0 }));
  }

  private async send<T>(index: number, method: string, params: unknown[]): Promise<T> {
    const stat = this.stats[index]!;
    const started = performance.now();
    stat.calls += 1;
    try {
      const response = await fetch(stat.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${stat.url}`);
      const payload = (await response.json()) as { result?: T; error?: RpcError };
      if (payload.error) throw new JsonRpcError(payload.error);
      stat.lastLatencyMs = performance.now() - started;
      return payload.result as T;
    } catch (error) {
      stat.errors += 1;
      throw error;
    }
  }

  /** Fan out to every endpoint and keep the first success — lowest achievable latency. */
  async race<T>(method: string, params: unknown[] = []): Promise<T> {
    if (this.urls.length === 1) return this.send<T>(0, method, params);
    const attempts = this.urls.map((_, index) =>
      this.send<T>(index, method, params).then((result) => {
        this.stats[index]!.wins += 1;
        return result;
      }),
    );
    return Promise.any(attempts).catch((error: AggregateError) => {
      throw error.errors?.[0] ?? error;
    });
  }

  /** Round-robin for calls that are not on the hot path. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const start = this.cursor++ % this.urls.length;
    let lastError: unknown;
    for (let offset = 0; offset < this.urls.length; offset += 1) {
      try {
        return await this.send<T>((start + offset) % this.urls.length, method, params);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Submit to every endpoint at once; duplicates are harmless, a lost race is not. */
  async broadcast(rawTx: `0x${string}`): Promise<`0x${string}`> {
    const attempts = this.urls.map(async (_, index) => {
      try {
        return await this.send<`0x${string}`>(index, 'eth_sendRawTransaction', [rawTx]);
      } catch (error) {
        if (error instanceof JsonRpcError && /already known|known transaction/i.test(error.message)) {
          throw error;
        }
        log.debug(`broadcast failed on ${this.urls[index]}`, (error as Error).message);
        throw error;
      }
    });
    return Promise.any(attempts).catch((error: AggregateError) => {
      throw error.errors?.[0] ?? error;
    });
  }
}
