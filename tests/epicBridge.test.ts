import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleEpicRequest } from '../server/epic';

let upstream: Server;
let bridge: Server;
let bridgeUrl = '';
const seen: Array<{ method?: string; url?: string; auth?: string; range?: string; body?: string }> = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, range: req.headers.range, body: await bodyOf(req) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/styles') return res.end(JSON.stringify([{ id: 'a', name: 'A', default: true }]));
    if (req.url === '/runs/r1') return res.end(JSON.stringify({ run_id: 'r1', status: 'running', steps: [{ n: 1, name: 'x', status: 'running' }] }));
    if (req.url === '/runs/r1/final.mp4') {
      res.statusCode = 206;
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-range', 'bytes 0-3/10');
      return res.end('abcd');
    }
    res.statusCode = 200;
    res.end('{"mode":"specific"}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.EPIC_REPLAY_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.EPIC_REPLAY_TOKEN = 'secret-token';
  bridge = createServer((req, res) => void handleEpicRequest(req, res));
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream.close();
  bridge.close();
  delete process.env.EPIC_REPLAY_URL;
  delete process.env.EPIC_REPLAY_TOKEN;
});

describe('epic bridge', () => {
  it('serves the start surface and sends the upstream token only upstream', async () => {
    const res = await fetch(`${bridgeUrl}/api/epic/start`);
    expect(await res.text()).toContain('"createSurface"');
    expect(seen.at(-1)?.auth).toBe('Bearer secret-token');
    const health = await (await fetch(`${bridgeUrl}/api/epic/health`)).text();
    expect(health).not.toContain('secret-token');
  });

  it('builds a progress surface for a run', async () => {
    const text = await (await fetch(`${bridgeUrl}/api/epic/runs/r1/surface`)).text();
    expect(text).toContain('StepList');
  });

  it('forwards Range for media and rejects other paths and bad ids', async () => {
    const res = await fetch(`${bridgeUrl}/api/epic/runs/r1/final.mp4`, { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('abcd');
    expect(seen.at(-1)?.range).toBe('bytes=0-3');
    expect((await fetch(`${bridgeUrl}/api/epic/runs/r1/artifacts/secret.json`)).status).toBe(404);
    expect((await fetch(`${bridgeUrl}/api/epic/runs/..%2Fx/surface`)).status).toBe(404);
  });

  it('maps actions to the play-card endpoint and rejects unknown actions and cross-origin posts', async () => {
    const post = (body: unknown, origin?: string) =>
      fetch(`${bridgeUrl}/api/epic/runs/r1/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body)
      });
    const ok = await post({ action: 'confirm', edits: { climax_frame: 5 }, context: {} });
    expect(ok.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/runs/r1/play-card');
    expect(JSON.parse(seen.at(-1)?.body ?? '{}')).toEqual({ action: 'confirm', edits: { climax_frame: 5 }, context: {} });
    expect((await post({ action: 'rerun' })).status).toBe(400);
    const before = seen.length;
    expect((await post({ action: 'reject' }, 'https://evil.example')).status).toBe(403);
    expect(seen.length).toBe(before);
  });
});
