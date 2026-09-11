import { type Address, type Hex, toFunctionSelector } from 'viem';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
export const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Signatures used by the mint entrypoints of the common drop stacks
 * (ERC721A, thirdweb, SeaDrop, Zora, Manifold, Magic Eden, generic customs).
 */
const MINT_SIGNATURES = [
  'mint(uint256)',
  'mint(address,uint256)',
  'mint(uint256,bytes)',
  'mint(address,uint256,bytes)',
  'mint()',
  'mintTo(address)',
  'mintTo(address,uint256)',
  'publicMint(uint256)',
  'publicMint(address,uint256)',
  'safeMint(address)',
  'safeMint(address,uint256)',
  'whitelistMint(uint256,bytes32[])',
  'allowlistMint(uint256,bytes32[])',
  'presaleMint(uint256,bytes32[])',
  'freeMint(uint256)',
  'batchMint(address,uint256)',
  'purchase(uint256)',
  'claim(address,uint256)',
  'claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)',
  'mintPublic(address,address,address,uint256)',
  'mintWithRewards(address,uint256,string,address)',
  'mintWithComment(address,uint256,string)',
  'mintNFT(uint256)',
  'buy(uint256)',
] as const;

/** Selectors that are definitely not mints; cheap rejection before anything else. */
const BLOCKED_SIGNATURES = [
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'setApprovalForAll(address,bool)',
  'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  'multicall(bytes[])',
  'deposit()',
  'withdraw(uint256)',
] as const;

function selectorSet(signatures: readonly string[]): Set<string> {
  return new Set(signatures.map((signature) => toFunctionSelector(signature)));
}

export const MINT_SELECTORS = selectorSet(MINT_SIGNATURES);
export const BLOCKED_SELECTORS = selectorSet(BLOCKED_SIGNATURES);

export function selectorOf(data: Hex | undefined): Hex | undefined {
  if (!data || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase() as Hex;
}

export type Verdict =
  | { kind: 'mint'; reason: 'selector' }
  | { kind: 'maybe-mint'; reason: 'payable-call' | 'unknown-selector' }
  | { kind: 'skip'; reason: string };

export interface CandidateTx {
  to: Address | null;
  input: Hex;
  value: bigint;
}

export function classify(tx: CandidateTx): Verdict {
  if (!tx.to) return { kind: 'skip', reason: 'contract deployment' };
  const selector = selectorOf(tx.input);
  if (!selector) return { kind: 'skip', reason: 'plain transfer' };
  if (BLOCKED_SELECTORS.has(selector)) return { kind: 'skip', reason: `blocked selector ${selector}` };
  if (MINT_SELECTORS.has(selector)) return { kind: 'mint', reason: 'selector' };
  if (tx.value > 0n) return { kind: 'maybe-mint', reason: 'payable-call' };
  return { kind: 'maybe-mint', reason: 'unknown-selector' };
}

export interface ReceiptLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

function topicAddress(topic: Hex | undefined): Address | undefined {
  if (!topic || topic.length !== 66) return undefined;
  return `0x${topic.slice(26)}`.toLowerCase() as Address;
}

/** Confirms a transaction actually minted: an NFT transfer out of the zero address. */
export function mintedCollections(logs: ReceiptLog[], recipient: Address): Address[] {
  const collections = new Set<Address>();
  for (const entry of logs) {
    const [topic0, topic1, topic2, topic3] = entry.topics;
    if (topic0 === TRANSFER_TOPIC && entry.topics.length === 4) {
      if (topic1 === ZERO_TOPIC && topicAddress(topic2) === recipient) {
        collections.add(entry.address.toLowerCase() as Address);
      }
      continue;
    }
    if (topic0 === TRANSFER_SINGLE_TOPIC || topic0 === TRANSFER_BATCH_TOPIC) {
      if (topic2 === ZERO_TOPIC && topicAddress(topic3) === recipient) {
        collections.add(entry.address.toLowerCase() as Address);
      }
    }
  }
  return [...collections];
}
