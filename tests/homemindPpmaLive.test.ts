/**
 * The PPMA client against a real PPMA (T6.1). Skipped unless PPMA_LIVE_URL and PPMA_LIVE_OWNER_TOKEN are
 * set, so `npm test` never needs PPMA. Use a throwaway PPMA, never one holding real data:
 *
 *   cd ../ppma && PPMA_OWNER_TOKEN=<32+ chars> uv run ppma serve --profile fake --auth strict --port 18765
 *   PPMA_LIVE_URL=http://127.0.0.1:18765 PPMA_LIVE_OWNER_TOKEN=<same> npx vitest run tests/homemindPpmaLive.test.ts
 *
 * The fake profile issues no commands, so the command loop is covered by scripts/fake-ppma.mjs instead.
 */
import { describe, expect, it } from 'vitest';
import { createPpmaClient, memorySyncStore } from '../server/homemind/ppma';

const url = process.env.PPMA_LIVE_URL;
const owner = process.env.PPMA_LIVE_OWNER_TOKEN;

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 100));
  }
}

describe.skipIf(!url || !owner)('PPMA client against a real PPMA', () => {
  it('registers, mints, opens the stream, and PPMA accepts every Homemind report', async () => {
    const lines: string[] = [];
    const sync = memorySyncStore();
    const client = createPpmaClient(
      { url: url!.replace(/\/+$/, ''), ownerToken: owner, ownerTokenFile: '', space: process.env.PPMA_SPACE || 'me', timeoutMs: 10_000, debug: 1 },
      { sync, log: line => lines.push(line) }
    );
    client.start();
    try {
      await until(() => client.status() === 'ok', 30_000);
      const at = new Date().toISOString();
      client.emit('homemind.item_changed', { item_id: 'live-check', change: 'created', item_type: 'event', title: 'Kindergarten party', start: at, status: 'open', ownership: 'none', actor_id: 'mom', actor_name: 'Mom' });
      client.emit('homemind.preference_stated', { preference_id: 'live-pref', change: 'added', about_member_id: 'noa', text: 'Bake a cake for her kindergarten party', reason: 'she enjoys it most', strength: 'soft', actor_id: 'mom' });
      client.emit('homemind.member_unavailable', { member_id: 'mom', event_id: 'live-wedding', from: at, to: at });
      client.emit('homemind.reminder_outcome', { reminder_id: 'live-r', item_id: 'live-check', response: 'got_it', member_id: 'dad' });
      expect(await client.drained(20_000)).toBe(true);
      // Nothing refused: a 422 would have logged "refused".
      expect(lines.filter(l => l.includes('refused'))).toEqual([]);
      expect(lines.some(l => /messages x\d+ 202/.test(l))).toBe(true);
      expect(client.status()).toBe('ok');
      // The owner can see a memory view (the app token can't, by design); the fake profile fills it soon.
      const views = await fetch(`${url}/v0/spaces/${process.env.PPMA_SPACE || 'me'}/memory/views`, { headers: { authorization: `Bearer ${owner}` } });
      expect(views.status).toBe(200);
    } finally {
      await client.stop();
      for (const line of lines) expect(line).not.toContain(owner!);
    }
    console.info(lines.join('\n'));
  }, 60_000);
});
