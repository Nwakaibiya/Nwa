import type { Address, Hex } from 'viem';

function word(address: Address): string {
  return address.toLowerCase().slice(2).padStart(64, '0');
}

export interface RewriteResult {
  data: Hex;
  replacements: number;
}

/**
 * Copies the target's calldata but points every occurrence of their address at
 * ours, so recipient/`mintTo` arguments mint into our wallet instead of theirs.
 * Only whole 32-byte words are touched, which leaves packed bytes/proofs intact.
 */
export function rewriteRecipient(data: Hex, from: Address, to: Address): RewriteResult {
  if (data.length <= 10) return { data, replacements: 0 };
  const selector = data.slice(0, 10);
  const body = data.slice(10);
  const needle = word(from);
  const replacement = word(to);
  let replacements = 0;
  let rewritten = '';
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const chunk = body.slice(offset, offset + 64);
    if (chunk.toLowerCase() === needle) {
      rewritten += replacement;
      replacements += 1;
    } else {
      rewritten += chunk;
    }
  }
  rewritten += body.slice(rewritten.length);
  return { data: `${selector}${rewritten}` as Hex, replacements };
}

/**
 * A merkle proof in the calldata means the drop is gated on an allowlist that
 * our wallet is not part of, so a copied proof would revert and waste gas.
 */
export function looksAllowlistGated(data: Hex): boolean {
  if (data.length <= 10) return false;
  const body = data.slice(10);
  const words = Math.floor(body.length / 64);
  for (let index = 0; index < words; index += 1) {
    const chunk = body.slice(index * 64, index * 64 + 64);
    // A dynamic array offset pointing inside the calldata, followed by a length
    // word with 32-byte non-address entries, is the merkle-proof shape.
    const value = BigInt(`0x${chunk}`);
    if (value > 0n && value < BigInt(body.length / 2) && value % 32n === 0n) {
      const pointer = Number(value) * 2;
      const lengthWord = body.slice(pointer, pointer + 64);
      if (lengthWord.length === 64) {
        const length = BigInt(`0x${lengthWord}`);
        if (length >= 1n && length <= 32n) {
          const first = body.slice(pointer + 64, pointer + 128);
          if (first.length === 64 && !first.startsWith('0'.repeat(24)) && BigInt(`0x${first}`) > 0n) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function scaleValue(value: bigint, bps: number): bigint {
  return (value * BigInt(Math.round(bps))) / 10_000n;
}
