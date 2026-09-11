import 'dotenv/config';
import { type Address, type Chain, isAddress } from 'viem';
import { resolveChain } from './chains.js';

export interface Config {
  telegramToken: string;
  ownerIds: number[];
  chain: Chain;
  rpcUrls: string[];
  privateKey: `0x${string}` | undefined;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  maxInFlight: number;
  backfillConcurrency: number;
  rpcTimeoutMs: number;
  feeRefreshMs: number;
  dataFile: string;
  publicUrl: string | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`"${value}" is not an EVM address`);
  return value.toLowerCase() as Address;
}

export interface LoadOptions {
  /** Scripts (latency, replay) only need chain access, not the Telegram surface. */
  requireTelegram?: boolean;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const requireTelegram = options.requireTelegram ?? true;
  const chainKey = process.env.CHAIN?.trim() || 'robinhood';
  const chainIdOverride = process.env.CHAIN_ID ? numberEnv('CHAIN_ID', 0) : undefined;
  const rpcOverrides = listEnv('RPC_URLS');
  const chain = resolveChain(chainKey, chainIdOverride, rpcOverrides);
  const rpcUrls = rpcOverrides.length ? rpcOverrides : [...chain.rpcUrls.default.http];

  const ownerIds = listEnv('TELEGRAM_OWNER_IDS').map((id) => {
    const parsed = Number(id);
    if (!Number.isInteger(parsed)) throw new Error(`TELEGRAM_OWNER_IDS contains a non-numeric id "${id}"`);
    return parsed;
  });
  if (requireTelegram && ownerIds.length === 0) {
    throw new Error('TELEGRAM_OWNER_IDS must list at least one Telegram user id (get yours from @userinfobot)');
  }

  const privateKey = process.env.PRIVATE_KEY?.trim();
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 32 byte hex string');
  }

  return {
    telegramToken: requireTelegram ? requireEnv('TELEGRAM_BOT_TOKEN') : (process.env.TELEGRAM_BOT_TOKEN ?? ''),
    ownerIds,
    chain,
    rpcUrls,
    privateKey: privateKey as `0x${string}` | undefined,
    pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 250),
    maxPollIntervalMs: numberEnv('MAX_POLL_INTERVAL_MS', 2000),
    maxInFlight: numberEnv('MAX_IN_FLIGHT_POLLS', 3),
    backfillConcurrency: numberEnv('BACKFILL_CONCURRENCY', 4),
    rpcTimeoutMs: numberEnv('RPC_TIMEOUT_MS', 4000),
    feeRefreshMs: numberEnv('FEE_REFRESH_MS', 2500),
    dataFile: process.env.DATA_FILE?.trim() || 'data/state.json',
    publicUrl: process.env.PUBLIC_URL?.trim() || undefined,
  };
}
