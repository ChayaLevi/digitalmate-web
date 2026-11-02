import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

/**
 * Runs the real Vite dev middleware stack (index.html fallback included) in front of the fake
 * Epic Replay server. Guards against the bridge handing a streamed media response to the next
 * middleware, which made Vite's HTML fallback throw "Cannot set headers after they are sent".
 */
let fake: ChildProcess;
let vite: ViteDevServer;
let base = '';
const errors: string[] = [];

beforeAll(async () => {
  fake = spawn('node', ['scripts/fake-epic-replay.mjs'], { env: { ...process.env, FAKE_EPIC_PORT: '18123' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch('http://127.0.0.1:18123/styles')).ok) break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  process.env.EPIC_REPLAY_URL = 'http://127.0.0.1:18123';
  vite = await createServer({
    configFile: 'vite.config.ts',
    logLevel: 'silent',
    customLogger: {
      info() {},
      warn() {},
      warnOnce() {},
      error: message => void errors.push(message),
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false
    },
    server: { port: 0, host: '127.0.0.1', hmr: false }
  });
  await vite.listen();
  base = `http://127.0.0.1:${vite.config.server.port ?? (vite.httpServer?.address() as { port: number }).port}`;
  const address = vite.httpServer?.address();
  if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await vite?.close();
  fake?.kill();
  delete process.env.EPIC_REPLAY_URL;
});

async function startRun(): Promise<string> {
  const form = new FormData();
  form.set('consent', 'true');
  form.set('file', new Blob(['x'], { type: 'video/mp4' }), 'c.mp4');
  const res = await fetch(`${base}/api/epic/runs`, { method: 'POST', body: form });
  return ((await res.json()) as { run_id: string }).run_id;
}

describe('epic bridge behind the real Vite middleware', () => {
  it('serves the final video, whole and by range, without Vite errors', async () => {
    const id = 'fake-past-1';
    const whole = await fetch(`${base}/api/epic/runs/${id}/final.mp4`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    const bytes = (await whole.arrayBuffer()).byteLength;
    expect(bytes).toBeGreaterThan(1000);
    const part = await fetch(`${base}/api/epic/runs/${id}/final.mp4`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const tail = await fetch(`${base}/api/epic/runs/${id}/final.mp4`, { headers: { range: `bytes=${bytes - 10}-` } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(errors).toEqual([]);
  });

  it('serves frames, the start surface and a run stream without Vite errors', async () => {
    const frame = await fetch(`${base}/api/epic/runs/fake-past-1/frames/313.jpg`);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    await frame.arrayBuffer();
    expect(await (await fetch(`${base}/api/epic/start`)).text()).toContain('createSurface');
    const id = await startRun();
    expect(id).toMatch(/^fake-/);
    const stream = await fetch(`${base}/api/epic/runs/${id}/stream`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    expect(stream?.headers.get('content-type')).toContain('text/event-stream');
    await stream?.body?.cancel().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(errors).toEqual([]);
  });

  it('still falls through to the app for other URLs', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('<div id="root">');
  });
});
