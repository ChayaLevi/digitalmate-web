import { createServer as createHttp } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

/**
 * A slow, large upstream video behind the real Vite middleware. Headers go out first, the body
 * follows in chunks. The bridge must own the response until the last byte (no fall-through to
 * Vite's HTML fallback), survive a browser that hangs up mid-stream and an upstream that dies
 * mid-body, and never raise an uncaught exception in the dev-server process.
 */
const TOTAL = 3_000_000;
let upstream: Server;
let vite: ViteDevServer;
let base = '';
const viteErrors: string[] = [];
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => void uncaught.push(error);

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  upstream = createHttp((req, res) => {
    const broken = req.url?.includes('broken');
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(TOTAL), 'accept-ranges': 'bytes' });
    res.flushHeaders();
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      if (broken && sent >= 600_000) {
        clearInterval(timer);
        return void res.socket?.destroy();
      }
      const n = Math.min(100_000, TOTAL - sent);
      res.write(Buffer.alloc(n, 1));
      sent += n;
      if (sent >= TOTAL) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.EPIC_REPLAY_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  vite = await createServer({
    configFile: 'vite.config.ts',
    logLevel: 'silent',
    customLogger: {
      info() {},
      warn() {},
      warnOnce() {},
      error: message => void viteErrors.push(message),
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false
    },
    server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false }
  });
  await vite.listen();
  base = `http://127.0.0.1:${(vite.httpServer?.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  await vite?.close();
  await new Promise(resolve => upstream?.close(resolve));
  delete process.env.EPIC_REPLAY_URL;
});

describe('epic video proxy under the Vite dev server', () => {
  it('streams a slow large video to the last byte without Vite errors', async () => {
    const res = await fetch(`${base}/api/epic/runs/r1/final.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect((await res.arrayBuffer()).byteLength).toBe(TOTAL);
    expect(viteErrors).toEqual([]);
    expect(uncaught).toEqual([]);
  }, 20_000);

  it('survives a browser that hangs up mid-video', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/epic/runs/r1/final.mp4`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(viteErrors).toEqual([]);
    expect(uncaught).toEqual([]);
    expect((await fetch(`${base}/api/epic/runs/r1/final.mp4`, { headers: { range: 'bytes=0-9' } })).status).toBe(200);
  }, 20_000);

  it('survives an upstream that dies mid-body', async () => {
    const res = await fetch(`${base}/api/epic/runs/broken/final.mp4`);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(viteErrors).toEqual([]);
    expect(uncaught).toEqual([]);
    expect((await fetch(`${base}/`)).status).toBe(200);
  }, 20_000);
});
