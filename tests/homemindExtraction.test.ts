import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import { fixedClock, localParts } from '../server/homemind/clock';
import { applyExtraction, suggestPrepTime, UNSURE_BELOW } from '../server/homemind/extraction';
import type { ExtractionResult } from '../server/homemind/extraction';
import { explainItem } from '../server/homemind/chat';
import { runExtraction } from '../server/homemind/intents';
import type { Extraction } from '../server/homemind/intents';
import { createLlmClient } from '../server/homemind/llm';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import type { MemberView } from '../server/homemind/visibility';
import { chatTurn } from '../src/lib/homemindSurfaces';
import type { ChatOutcome } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const fresh = (): HomemindState => seedState({ now: NOW, timezone: TZ });
const SHOT = { source: { kind: 'screenshot' as const, label: 'Mom' } };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const local = (iso: string | undefined) => (iso ? `${localParts(Date.parse(iso), TZ).date} ${localParts(Date.parse(iso), TZ).time}` : '');

const empty = (): Extraction => ({ events: [], preparations: [], requests: [], signUp: null, dropped: 0 });

function ok(result: ReturnType<typeof applyExtraction>): ExtractionResult {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

/** The simulated 接龙 sample, read by the fake model, the way the bridge does it. */
async function sample(): Promise<Extraction> {
  const llm = createLlmClient({ mode: 'fake', timeoutMs: 1000, debug: 0 });
  const result = await runExtraction(llm, { now: NOW, timezone: TZ, imageDataUrl: PNG });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const byTitle = (state: HomemindState, title: string) => state.items.find(i => i.title === title) as Item;

describe('applyExtraction: the 接龙 screenshot becomes proposed items', () => {
  it('creates proposed events, preparations under them and a task, all from the screenshot', async () => {
    const result = ok(applyExtraction(fresh(), await sample(), 'mom', clock, SHOT));
    const party = byTitle(result.state, '秋季水果派对');
    const checkup = byTitle(result.state, '全园体检');
    expect(party).toMatchObject({ type: 'event', status: 'proposed', source: { kind: 'screenshot', label: 'Mom' }, createdBy: 'mom' });
    expect(local(party.start)).toBe('2026-11-05 15:00');
    expect(party.notes).toContain('秋季水果派对');
    const fruit = byTitle(result.state, '切好装盒的水果（够8个小朋友）');
    expect(fruit).toMatchObject({ type: 'preparation', parentEventId: party.id, status: 'proposed' });
    expect(byTitle(result.state, '穿方便穿脱的衣服')).toMatchObject({ type: 'preparation', parentEventId: checkup.id });
    expect(byTitle(result.state, '接龙认领要带的水果')).toMatchObject({ type: 'task', status: 'proposed' });
    expect(result.created.map(c => c.kind)).toEqual(['event', 'event', 'preparation', 'preparation', 'request']);
    expect(result.created.every(c => !c.suggestedTime && !c.unsure)).toBe(true);
    // One activity per item, and one event per item for the streams.
    expect(result.activityIds).toHaveLength(5);
    expect(result.events.filter(e => e.item?.status === 'proposed')).toHaveLength(5);
  });

  it('each item has a "Why?" record quoting the source, from the model', async () => {
    const result = ok(applyExtraction(fresh(), await sample(), 'mom', clock, SHOT));
    const party = byTitle(result.state, '秋季水果派对');
    const e = explainItem(viewFor(result.state, 'dad') as MemberView, party.id);
    expect(e?.source.kind).toBe('screenshot');
    expect(e?.why).toMatchObject({ source: 'model', basis: [{ kind: 'quote', ref: party.id }, { kind: 'confidence', ref: party.id, note: '0.95' }] });
    expect(e?.why?.summary).toContain('秋季水果派对');
  });

  it('the same screenshot twice adds nothing the second time', async () => {
    const first = ok(applyExtraction(fresh(), await sample(), 'mom', clock, SHOT));
    const second = ok(applyExtraction(first.state, await sample(), 'dad', clock, SHOT));
    expect(second.created).toEqual([]);
    expect(second.skipped.map(s => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(second.state.items).toHaveLength(first.state.items.length);
  });

  it('text from chat is proposed too, even though the core would allow it open', () => {
    const ex = { ...empty(), requests: [{ text: 'Bring a towel', confidence: 0.9, quote: 'bring a towel' }] };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, { source: { kind: 'chat', label: 'Mom' } }));
    expect(byTitle(result.state, 'Bring a towel').status).toBe('proposed');
  });
});

describe('applyExtraction: suggested times, matching and limits', () => {
  it('a preparation without a time is suggested for the evening before, marked as suggested', () => {
    const ex: Extraction = {
      ...empty(),
      events: [{ title: 'Class trip', start: '2026-11-07T08:00:00+08:00', confidence: 0.9, quote: 'class trip Saturday 8am' }],
      preparations: [{ title: 'Pack lunch', forEvent: 'Class trip', confidence: 0.9, quote: 'bring a packed lunch' }]
    };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    const lunch = byTitle(result.state, 'Pack lunch');
    expect(lunch.parentEventId).toBe(byTitle(result.state, 'Class trip').id);
    expect(local(lunch.start)).toBe('2026-11-06 20:00');
    expect(result.created.find(c => c.itemId === lunch.id)).toMatchObject({ suggestedTime: true });
  });

  it('a preparation due when its event starts gets a suggested time instead', () => {
    const ex: Extraction = {
      ...empty(),
      events: [{ title: 'Open day', start: '2026-11-09T02:00:00Z', confidence: 0.9, quote: 'open day Monday 10am' }],
      preparations: [{ title: 'Bring a cup', due: '2026-11-09T02:00:00Z', forEvent: 'Open day', confidence: 0.9, quote: 'bring a cup' }]
    };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    expect(local(byTitle(result.state, 'Bring a cup').start)).toBe('2026-11-08 20:00');
    expect(result.created[1]).toMatchObject({ suggestedTime: true });
  });

  it('when the evening before has passed, an hour before; when the event is about to start, no time', () => {
    expect(local(suggestPrepTime('2026-11-04T18:00:00+08:00', NOW, TZ))).toBe('2026-11-04 17:00');
    expect(suggestPrepTime('2026-11-04T10:30:00+08:00', NOW, TZ)).toBeUndefined();
  });

  it('a preparation for an event already on the board goes under it', () => {
    const ex = { ...empty(), preparations: [{ title: 'Bring a cake', forEvent: "Family dinner at Grandma's", confidence: 0.8, quote: 'bring a cake' }] };
    const state = fresh();
    const dinner = state.items.find(i => i.title === "Family dinner at Grandma's") as Item;
    const result = ok(applyExtraction(state, ex, 'mom', clock, SHOT));
    expect(byTitle(result.state, 'Bring a cake')).toMatchObject({ type: 'preparation', parentEventId: dinner.id, status: 'proposed' });
  });

  it('a preparation with no event to go under becomes a task; a teen cannot attach to a Parents-only event', () => {
    const ex = { ...empty(), preparations: [{ title: 'Bring the form', forEvent: "Meeting with Maya's school counselor", confidence: 0.8, quote: 'bring the form' }] };
    const result = ok(applyExtraction(fresh(), ex, 'maya', clock, SHOT));
    const form = byTitle(result.state, 'Bring the form');
    expect(form.type).toBe('task');
    expect(form.parentEventId).toBeUndefined();
    expect(form.visibility).toBe('family');
  });

  it('skips an event that is already over, and marks low confidence as unsure', () => {
    const ex: Extraction = {
      ...empty(),
      events: [
        { title: 'Yesterday show', start: '2026-11-03T15:00:00+08:00', confidence: 0.9, quote: 'yesterday show' },
        { title: 'Maybe a picnic', start: '2026-11-08T11:00:00+08:00', confidence: UNSURE_BELOW - 0.1, quote: 'maybe picnic' }
      ]
    };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    expect(result.skipped).toEqual([{ kind: 'event', title: 'Yesterday show', reason: 'past' }]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ unsure: true });
  });

  it('a preparation that names no event is a task, not a guess under the only event', () => {
    const ex: Extraction = {
      ...empty(),
      events: [{ title: 'Picture day', start: '2026-11-10T00:30:00Z', confidence: 0.9, quote: 'picture day' }],
      preparations: [{ title: 'Return the permission slip', due: '2026-11-13T15:59:00Z', confidence: 0.85, quote: 'return the slip by Friday' }]
    };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    expect(byTitle(result.state, 'Return the permission slip')).toMatchObject({ type: 'task', status: 'proposed' });
  });

  it('an old screenshot: everything is over, nothing is added, and each entry says why', async () => {
    const later = fixedClock(NOW + 8 * 24 * 60 * 60 * 1000);
    const result = ok(applyExtraction(fresh(), await sample(), 'mom', later, SHOT));
    expect(result.created).toEqual([]);
    expect(result.skipped.map(s => `${s.kind}:${s.reason}`)).toEqual(['event:past', 'event:past', 'preparation:past', 'preparation:past', 'request:past']);
  });

  it('nothing to add leaves the state as it was', () => {
    const state = fresh();
    const result = ok(applyExtraction(state, empty(), 'mom', clock, SHOT));
    expect(result.state).toBe(state);
    expect(result.created).toEqual([]);
  });
});

describe('approving a proposed event approves its preparations (one tap)', () => {
  it('approve, then Undo restores all of them; dismiss removes them together', async () => {
    const { state } = ok(applyExtraction(fresh(), await sample(), 'mom', clock, SHOT));
    const party = byTitle(state, '秋季水果派对');
    const approved = applyChange(state, { kind: 'approve', itemId: party.id, version: party.version }, 'dad', clock);
    if (!approved.ok) throw new Error(approved.message);
    expect(byTitle(approved.state, '秋季水果派对').status).toBe('open');
    expect(byTitle(approved.state, '切好装盒的水果（够8个小朋友）').status).toBe('open');
    // The other event's preparation is untouched.
    expect(byTitle(approved.state, '穿方便穿脱的衣服').status).toBe('proposed');
    const undone = applyChange(approved.state, { kind: 'undo', activityId: approved.activity.id }, 'dad', clock);
    if (!undone.ok) throw new Error(undone.message);
    expect(byTitle(undone.state, '切好装盒的水果（够8个小朋友）').status).toBe('proposed');

    const checkup = byTitle(state, '全园体检');
    const dismissed = applyChange(state, { kind: 'dismiss', itemId: checkup.id, version: checkup.version }, 'mom', clock);
    if (!dismissed.ok) throw new Error(dismissed.message);
    expect(byTitle(dismissed.state, '穿方便穿脱的衣服').status).toBe('cancelled');
  });
});

describe('chatTurn: the screenshot card', () => {
  async function card(lang: 'en' | 'zh', llm: 'fake' | 'live' = 'fake') {
    const ex = await sample();
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    const outcome: ChatOutcome = { kind: 'extracted', created: result.created, skipped: result.skipped, dropped: 0, signUp: ex.signUp ? { topic: ex.signUp.topic, deadline: ex.signUp.deadline, taken: ex.signUp.taken } : undefined };
    return chatTurn({ lang, now: new Date(NOW).toISOString(), view: viewFor(result.state, 'mom') as MemberView, llm, turnId: 't1', outcome });
  }

  it('lists the proposed items with Approve, the quotes, the sign-up, and says nothing is final (EN)', async () => {
    const turn = await card('en');
    expect(turn.message).toContain('5 suggestion(s) are on the board, waiting for approval');
    expect(turn.message).toContain('Approving an event also approves its preparations');
    const surface = A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
    const rows = surface.data.rows as Array<{ title: string; actions: Array<{ args: { verb: string } }> }>;
    // Events first, each followed by its preparation.
    expect(rows.map(r => r.title)).toEqual(['秋季水果派对', '切好装盒的水果（够8个小朋友）', '全园体检', '穿方便穿脱的衣服', '接龙认领要带的水果']);
    expect(rows.every(r => r.actions.some(a => a.args.verb === 'approve'))).toBe(true);
    expect(JSON.stringify(surface.data.quotes)).toContain('切好装盒，够8个小朋友吃');
    expect(JSON.stringify(surface.data.signup)).toContain('苹果 (乐乐妈妈)');
    expect(turn.jsonl).toContain('Check the quotes before approving');
    expect(turn.jsonl).toContain('Simulated model');
  });

  it('in Chinese, and without the simulated label for the live model', async () => {
    const turn = await card('zh', 'live');
    expect(turn.message).toContain('5 条建议已放到看板上');
    expect(turn.jsonl).toContain('截图中的接龙');
    expect(turn.jsonl).toContain('确认添加前请核对原文');
    expect(turn.jsonl).not.toContain('模拟模型');
  });

  it('marks a suggested time, and says when nothing new was found', () => {
    const ex: Extraction = { ...empty(), events: [{ title: 'Class trip', start: '2026-11-07T08:00:00+08:00', confidence: 0.9, quote: 'trip' }], preparations: [{ title: 'Pack lunch', forEvent: 'class trip', confidence: 0.9, quote: 'lunch' }] };
    const result = ok(applyExtraction(fresh(), ex, 'mom', clock, SHOT));
    const view = viewFor(result.state, 'mom') as MemberView;
    const turn = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view, llm: 'live', turnId: 't2', outcome: { kind: 'extracted', created: result.created, skipped: [], dropped: 0 } });
    expect(turn.jsonl).toContain('time suggested by Homemind');
    const none = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view, llm: 'live', turnId: 't3', outcome: { kind: 'extracted', created: [], skipped: [{ kind: 'event', title: 'x', reason: 'duplicate' }], dropped: 0 } });
    expect(none.message).toContain('found nothing new');
    expect(none.message).toContain('1 entry(ies) were already on the board');
  });

  it('"Why?" on a screenshot item quotes the source and names the model', async () => {
    const { state } = ok(applyExtraction(fresh(), await sample(), 'mom', clock, SHOT));
    const view = viewFor(state, 'mom') as MemberView;
    const party = byTitle(state, '秋季水果派对');
    const turn = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view, llm: 'live', turnId: 't4', outcome: { kind: 'why', explanation: explainItem(view, party.id)! } });
    expect(turn.message).toContain('The model read “秋季水果派对” from a screenshot');
    expect(turn.jsonl).toContain('Read from a screenshot');
    expect(turn.jsonl).toContain('the model');
  });

  it('a model failure on a screenshot is an error card', () => {
    const turn = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: viewFor(fresh(), 'mom') as MemberView, llm: 'live', turnId: 't5', outcome: { kind: 'failed', reason: 'image', code: 'invalid', message: 'x' } });
    expect(turn.jsonl).toContain('ErrorNotice');
    expect(turn.jsonl).toContain('could not read this screenshot');
  });
});
