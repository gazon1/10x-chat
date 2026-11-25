import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAcpClient } from '../spike/acp/client.mjs';

// A runtime that breaks the protocol on purpose: every method gets a broken
// answer first, and then a valid one. The client has to record every
// violation and still settle the request that has a valid answer.
const SERVER = `
const broken = {
  malformed: () => 'this is not json',
  envelope: () => JSON.stringify({ jsonrpc: '1.0', id: 0, result: {} }),
  scalar: () => '42',
  empty: () => JSON.stringify({ jsonrpc: '2.0', id: 0 }),
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const breaker = broken[msg.method];
    if (breaker) {
      const payload = breaker();
      process.stdout.write(payload.replace('"id":0', '"id":' + msg.id) + '\\n');
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: msg.method } }) + '\\n',
    );
  }
});
`;

const start = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-client-'));
  const script = join(dir, 'server.mjs');
  writeFileSync(script, SERVER);
  const client = createAcpClient({ command: 'node', args: [script] });
  return client;
};

describe('the ACP client', () => {
  it('records every violation of the protocol and settles the requests that have an answer', async () => {
    const client = await start();
    const ok = await client.request('valid', {}, { timeoutMs: 10000 });
    expect(ok).toEqual({ ok: 'valid' });
    expect(client.protocolErrors()).toEqual([]);
    await client.close();
  });

  it('records a line that is not JSON', async () => {
    const client = await start();
    const ok = await client.request('malformed', {}, { timeoutMs: 10000 });
    expect(ok).toEqual({ ok: 'malformed' });
    expect(client.protocolErrors().map((e: { kind: string }) => e.kind)).toContain(
      'malformed-line',
    );
    await client.close();
  });

  it('records an envelope that is not JSON-RPC 2.0', async () => {
    const client = await start();
    const ok = await client.request('envelope', {}, { timeoutMs: 10000 });
    expect(ok).toEqual({ ok: 'envelope' });
    expect(client.protocolErrors().map((e: { kind: string }) => e.kind)).toContain(
      'invalid-envelope',
    );
    await client.close();
  });

  it('records a message that is not an object', async () => {
    const client = await start();
    const ok = await client.request('scalar', {}, { timeoutMs: 10000 });
    expect(ok).toEqual({ ok: 'scalar' });
    expect(client.protocolErrors().map((e: { kind: string }) => e.kind)).toContain(
      'invalid-message',
    );
    await client.close();
  });

  it('refuses a response that carries neither a result nor an error', async () => {
    const client = await start();
    await expect(client.request('empty', {}, { timeoutMs: 10000 })).rejects.toThrow(
      /neither result nor error/,
    );
    expect(client.protocolErrors().map((e: { kind: string }) => e.kind)).toContain(
      'invalid-response',
    );
    await client.close();
  });
});
