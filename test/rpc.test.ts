import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { RateLimitedError, RpcPool } from '../src/rpc.js';

interface Fake {
  server: Server;
  url: string;
  requests: number;
  status: number;
}

async function startFake(status: number): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as Server, url: '', requests: 0, status };
  fake.server = createServer((request, response) => {
    fake.requests += 1;
    request.resume();
    if (fake.status !== 200) {
      response.writeHead(fake.status, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  fake.url = `http://127.0.0.1:${address.port}`;
  return fake;
}

test('parks a rate limited endpoint instead of hammering it', async () => {
  const fake = await startFake(429);
  try {
    const pool = new RpcPool([fake.url], 1000);
    await assert.rejects(pool.race('eth_blockNumber'));
    assert.equal(fake.requests, 1);
    assert.equal(pool.throttled, true);
    await assert.rejects(pool.race('eth_blockNumber'), RateLimitedError);
    await assert.rejects(pool.call('eth_blockNumber'), RateLimitedError);
    assert.equal(fake.requests, 1, 'cooled endpoint must not receive further requests');
    assert.equal(pool.stats[0]!.rateLimited, 1);
  } finally {
    fake.server.close();
  }
});

test('keeps serving from a healthy endpoint while another is throttled', async () => {
  const limited = await startFake(429);
  const healthy = await startFake(200);
  try {
    const pool = new RpcPool([limited.url, healthy.url], 1000);
    assert.equal(await pool.race<string>('eth_blockNumber'), '0x1');
    assert.equal(pool.throttled, false);
    assert.equal(await pool.call<string>('eth_blockNumber'), '0x1');
    assert.equal(limited.requests, 1, 'throttled endpoint is skipped after its first 429');
  } finally {
    limited.server.close();
    healthy.server.close();
  }
});

test('clears the cooldown once an endpoint answers again', async () => {
  const fake = await startFake(429);
  try {
    const pool = new RpcPool([fake.url], 1000);
    await assert.rejects(pool.race('eth_blockNumber'));
    fake.status = 200;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await pool.race<string>('eth_blockNumber'), '0x1');
    assert.equal(pool.throttled, false);
    assert.equal(pool.stats[0]!.cooldownUntil, 0);
  } finally {
    fake.server.close();
  }
});
