import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleFridgeRequest, householdFromCookie } from '../server/fridge';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import type { FridgeTurn } from '../src/lib/fridgeSurfaces';

const FAKE_PORT = 18000 + Math.floor(Math.random() * 1000);
let fake: ChildProcess;
let bridge: Server;
let bridgeUrl = '';
let cookie = '';

async function startFake(): Promise<void> {
  fake = spawn(process.execPath, ['scripts/fake-fridge2table.mjs'], {
    env: { ...process.env, FAKE_F2T_PORT: String(FAKE_PORT), FAKE_F2T_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise<void>((resolve, reject) => {
    fake.stdout?.on('data', chunk => {
      if (String(chunk).includes('Fake Fridge2Table')) resolve();
    });
    fake.on('exit', code => reject(new Error(`fake exited ${code}`)));
  });
}

async function turnOf(res: Response): Promise<FridgeTurn> {
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return (await res.json()) as FridgeTurn;
}

function surfaceOf(turn: FridgeTurn) {
  return A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
}

function chatForm(message: string, images = 0): FormData {
  const form = new FormData();
  form.append('session_id', 'dm_test_1');
  form.append('message', message);
  form.append('cook_mode', 'home');
  for (let index = 0; index < images; index += 1) {
    form.append('images', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), `p${index}.jpg`);
    form.append('locations', 'fridge');
  }
  return form;
}

beforeAll(async () => {
  await startFake();
  process.env.FRIDGE2TABLE_URL = `http://127.0.0.1:${FAKE_PORT}`;
  bridge = createServer((req, res) => void handleFridgeRequest(req, res));
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterAll(() => {
  fake?.kill();
  bridge?.close();
  delete process.env.FRIDGE2TABLE_URL;
  delete process.env.FRIDGE2TABLE_HOUSEHOLD;
});

describe('fridge2table bridge', () => {
  it('reports health without exposing the upstream household', async () => {
    const health = await (await fetch(`${bridgeUrl}/api/fridge/health`)).json();
    expect(health).toMatchObject({ configured: true, reachable: true, pinnedHousehold: false });
  });

  it('turns a chat turn into text, trace steps and a RecipeOptions surface, and keeps the household', async () => {
    const turn = await turnOf(await fetch(`${bridgeUrl}/api/fridge/chat`, { method: 'POST', body: chatForm('What can I cook tonight?') }));
    expect(turn.message).toContain('Three ideas');
    expect(turn.thinking).toContain('read your kitchen');
    const surface = surfaceOf(turn);
    expect(surface.components.meals.component).toBe('RecipeOptions');
    expect((surface.data.meals as unknown[]).length).toBe(3);
    expect(cookie).toMatch(/^dm_f2t_household=[0-9a-f]{32}$/);
    expect(householdFromCookie(cookie)).toBeTruthy();
  });

  it('forwards photos with their place tags', async () => {
    const turn = await turnOf(
      await fetch(`${bridgeUrl}/api/fridge/chat`, { method: 'POST', headers: { cookie }, body: chatForm('here is my fridge', 2) })
    );
    expect(turn.message).toContain('2 photo(s)');
    expect(turn.followUps[0]).toContain('bell pepper');
  });

  it('serves steps, made (with undo), bought and inventory in the same household', async () => {
    const steps = await turnOf(await fetch(`${bridgeUrl}/api/fridge/recipe/a1b2c3/steps`, { headers: { cookie } }));
    expect(String(surfaceOf(steps).components.method.text)).toContain('1. Heat the oven grill.');

    const post = (path: string, body: unknown) =>
      fetch(`${bridgeUrl}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const made = await turnOf(await post('/api/fridge/recipe/a1b2c3/made', { substitutions: [] }));
    expect(made.message).toContain('Eggs plenty → some');
    const tokens = surfaceOf(made).components.actions.actions?.[0].args?.tokens as string[];
    const undone = await turnOf(await post('/api/fridge/inventory/undo', { tokens }));
    expect(undone.message).toBe('Undone.');
    const fridge = surfaceOf(undone).data.fridge as Array<Record<string, string>>;
    expect(fridge.find(row => row.label === 'Eggs')?.value).toBe('plenty');

    const bought = await turnOf(await post('/api/fridge/inventory/bought', { items: [{ name: 'parmesan', category: 'dairy' }] }));
    expect(bought.message).toBe('Added to your kitchen: parmesan');
    const kitchen = await turnOf(await fetch(`${bridgeUrl}/api/fridge/inventory`, { headers: { cookie } }));
    expect(JSON.stringify(surfaceOf(kitchen).data.pantry)).toContain('parmesan');
  });

  it('proxies dish photos as images', async () => {
    const res = await fetch(`${bridgeUrl}/api/fridge/recipe/a1b2c3/photo`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it('shows upstream errors as an error surface instead of failing the chat', async () => {
    const turn = await turnOf(await fetch(`${bridgeUrl}/api/fridge/recipe/zzzzzz/steps`, { headers: { cookie } }));
    expect(surfaceOf(turn).components.err.body).toContain('Unknown recipe id');
  });

  it('rejects bad ids, unknown paths, non-multipart chat and cross-origin posts', async () => {
    expect((await fetch(`${bridgeUrl}/api/fridge/recipe/..%2Fadmin/steps`)).status).toBe(404);
    expect((await fetch(`${bridgeUrl}/api/fridge/admin/reset`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${bridgeUrl}/api/fridge/chat`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const evil = await fetch(`${bridgeUrl}/api/fridge/chat`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: chatForm('hi') });
    expect(evil.status).toBe(403);
  });

  it('pins every browser to FRIDGE2TABLE_HOUSEHOLD when set', async () => {
    process.env.FRIDGE2TABLE_HOUSEHOLD = 'c'.repeat(32);
    try {
      const res = await fetch(`${bridgeUrl}/api/fridge/inventory`);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect((await (await fetch(`${bridgeUrl}/api/fridge/health`)).json()).pinnedHousehold).toBe(true);
    } finally {
      delete process.env.FRIDGE2TABLE_HOUSEHOLD;
    }
  });

  it('answers with an unreachable surface when Fridge2Table is down', async () => {
    process.env.FRIDGE2TABLE_URL = 'http://127.0.0.1:1';
    try {
      const turn = await turnOf(await fetch(`${bridgeUrl}/api/fridge/inventory`));
      expect(surfaceOf(turn).components.err.body).toContain('FRIDGE2TABLE_URL');
    } finally {
      process.env.FRIDGE2TABLE_URL = `http://127.0.0.1:${FAKE_PORT}`;
    }
  });
});
