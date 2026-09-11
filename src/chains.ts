import type { Chain } from 'viem';
import { defineChain } from 'viem';
import { base, mainnet } from 'viem/chains';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.mainnet.chain.robinhood.com' },
  },
});

export const KNOWN_CHAINS: Record<string, Chain> = {
  robinhood: robinhoodChain,
  ethereum: mainnet,
  base,
};

/**
 * Any EVM network works: unknown keys (e.g. `arc`) are accepted as long as
 * CHAIN_ID and RPC_URLS are supplied, so a new chain is a config change only.
 */
export function resolveChain(key: string, overrideId?: number, overrideRpcs?: string[]): Chain {
  const preset = KNOWN_CHAINS[key.toLowerCase()];
  if (!preset && (!overrideId || !overrideRpcs?.length)) {
    throw new Error(
      `Unknown CHAIN "${key}": set CHAIN_ID and RPC_URLS to use it, or pick one of ${Object.keys(KNOWN_CHAINS).join(', ')}.`,
    );
  }
  const template = preset ?? robinhoodChain;
  if (!overrideId && !overrideRpcs?.length) return template;
  return defineChain({
    ...template,
    id: overrideId ?? template.id,
    name: preset ? template.name : `${key} (${overrideId})`,
    rpcUrls: overrideRpcs?.length ? { default: { http: overrideRpcs } } : template.rpcUrls,
    blockExplorers: preset ? template.blockExplorers : undefined,
  });
}
