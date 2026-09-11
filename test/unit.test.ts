import assert from 'node:assert/strict';
import test from 'node:test';
import { type Address, type Hex, encodeFunctionData, parseEther, toFunctionSelector } from 'viem';
import { looksAllowlistGated, rewriteRecipient, scaleValue } from '../src/calldata.js';
import { classify, mintedCollections, TRANSFER_TOPIC, ZERO_TOPIC } from '../src/detect.js';

const TARGET = '0x1111111111111111111111111111111111111111' as Address;
const OURS = '0x2222222222222222222222222222222222222222' as Address;
const COLLECTION = '0x3333333333333333333333333333333333333333' as Address;

function pad(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, '0')}` as Hex;
}

test('rewrites the recipient argument of a mintTo call', () => {
  const data = encodeFunctionData({
    abi: [{ name: 'mintTo', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }] }],
    args: [TARGET, 3n],
  });
  const { data: rewritten, replacements } = rewriteRecipient(data, TARGET, OURS);
  assert.equal(replacements, 1);
  assert.ok(rewritten.toLowerCase().includes(OURS.slice(2)));
  assert.ok(!rewritten.toLowerCase().includes(TARGET.slice(2)));
  assert.equal(rewritten.slice(0, 10), data.slice(0, 10));
  assert.equal(rewritten.length, data.length);
});

test('leaves calldata untouched when the target address does not appear', () => {
  const data = encodeFunctionData({
    abi: [{ name: 'mint', type: 'function', inputs: [{ type: 'uint256' }] }],
    args: [2n],
  });
  const { data: rewritten, replacements } = rewriteRecipient(data, TARGET, OURS);
  assert.equal(replacements, 0);
  assert.equal(rewritten, data);
});

test('classifies known mint selectors, rejects transfers and deployments', () => {
  const mint = toFunctionSelector('mint(uint256)') as Hex;
  assert.equal(classify({ to: COLLECTION, input: `${mint}${'0'.repeat(64)}`, value: 0n }).kind, 'mint');

  const transfer = toFunctionSelector('transfer(address,uint256)') as Hex;
  assert.equal(classify({ to: COLLECTION, input: `${transfer}${'0'.repeat(128)}`, value: 0n }).kind, 'skip');

  assert.equal(classify({ to: null, input: '0xdeadbeef', value: 0n }).kind, 'skip');
  assert.equal(classify({ to: COLLECTION, input: '0x', value: parseEther('1') }).kind, 'skip');
});

test('treats an unknown payable call as a mint candidate', () => {
  const verdict = classify({ to: COLLECTION, input: '0xabcdef12', value: parseEther('0.01') });
  assert.equal(verdict.kind, 'maybe-mint');
  assert.equal(verdict.reason, 'payable-call');
});

test('detects an ERC721 mint in receipt logs', () => {
  const logs = [
    { address: COLLECTION, topics: [TRANSFER_TOPIC, ZERO_TOPIC, pad(TARGET), pad(OURS)] as Hex[], data: '0x' as Hex },
  ];
  assert.deepEqual(mintedCollections(logs, TARGET), [COLLECTION]);
  assert.deepEqual(mintedCollections(logs, OURS), []);
});

test('ignores ERC20 transfers from the zero address', () => {
  const logs = [
    {
      address: COLLECTION,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC, pad(TARGET)] as Hex[],
      data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000' as Hex,
    },
  ];
  assert.deepEqual(mintedCollections(logs, TARGET), []);
});

test('flags merkle-proof gated mints', () => {
  const gated = encodeFunctionData({
    abi: [
      {
        name: 'whitelistMint',
        type: 'function',
        inputs: [{ type: 'uint256' }, { type: 'bytes32[]' }],
      },
    ],
    args: [1n, ['0xabababababababababababababababababababababababababababababababab']],
  });
  assert.equal(looksAllowlistGated(gated), true);

  const open = encodeFunctionData({
    abi: [{ name: 'mint', type: 'function', inputs: [{ type: 'uint256' }] }],
    args: [1n],
  });
  assert.equal(looksAllowlistGated(open), false);
});

test('scales value by basis points', () => {
  assert.equal(scaleValue(parseEther('1'), 10_000), parseEther('1'));
  assert.equal(scaleValue(parseEther('1'), 5_000), parseEther('0.5'));
  assert.equal(scaleValue(parseEther('1'), 0), 0n);
});
