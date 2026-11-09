import { describe, expect, it } from 'vitest';
import { executeAction, issueConfirmation } from '../server/homemind/actions';
import type { AdapterRegistry, StateRef } from '../server/homemind/actions';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import { createSimulatedAdapters, postNextGroupMessage, servicesOf, servicesViewFor, updateGroupMessages, updatesLeft } from '../server/homemind/fakes';
import { afterGroupCard, applyGroupPolicy, considerSignUps, groupsView, requestGroupChange } from '../server/homemind/groupClaims';
import { tickReminders } from '../server/homemind/reminders';
import { seedState } from '../server/homemind/seed';
import { detectSourceChanges, resolveSourceChange, sourceChangesView, undoSourceChange } from '../server/homemind/sourceChanges';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindViewData } from '../src/lib/homemindSurfaces';

const ZONE = 'Asia/Shanghai';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // Shanghai local
const MON_10 = at(2026, 11, 9, 10);
const MON_11 = MON_10 + HOUR;
const THU_15 = at(2026, 11, 12, 15);
const FRI_15 = at(2026, 11, 13, 15);
const KEY = 'test-key-0123456789';
const iso = (ms: number) => new Date(ms).toISOString();

function holder(state: HomemindState, now: number) {
  const box = { state, now };
  const adapters = createSimulatedAdapters({ get: () => box.state, set: s => void (box.state = s), now: () => box.now });
  const ref: StateRef = { get: () => box.state, set: s => void (box.state = s) };
  return { box, adapters, ref };
}

function withSignUp(): HomemindState {
  let state = seedState({ now: MON_10, timezone: ZONE });
  for (let i = 0; i < 2; i++) {
    const posted = postNextGroupMessage(state, MON_10);
    if (!posted.ok) throw new Error('fixture');
    state = posted.state;
  }
  return state;
}

function turnOn(state: HomemindState, auto: boolean): HomemindState {
  const result = applyGroupPolicy(state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto }, 'mom', MON_10);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

async function runAuto(box: { state: HomemindState; now: number }, ref: StateRef, adapters: AdapterRegistry, cardId: string) {
  const ran = await executeAction(ref, cardId, { kind: 'auto' }, { adapters, key: KEY, now: () => box.now });
  const card = box.state.actionCards.find(c => c.id === cardId)!;
  const after = afterGroupCard(box.state, card, box.now, fixedClock(box.now));
  if (after) box.state = after.state;
  return { ran, after };
}

/** Level 4: apples claimed and posted; optionally changed to cake. */
async function claimed(cake = false) {
  const h = holder(turnOn(withSignUp(), true), MON_10);
  h.box.state = considerSignUps(h.box.state, MON_10, h.adapters).state;
  await runAuto(h.box, h.ref, h.adapters, h.box.state.groupClaims![0].cardId!);
  if (cake) {
    const asked = requestGroupChange(h.box.state, h.box.state.groupClaims![0].id, 'cake', 'mom', MON_10, h.adapters);
    if (!asked.ok) throw new Error(asked.message);
    h.box.state = asked.state;
    await runAuto(h.box, h.ref, h.adapters, asked.card.id);
  }
  return h;
}

/** The demo control, then detection, at `now`. */
function update(state: HomemindState, now = MON_11) {
  const updated = updateGroupMessages(state, now);
  if (!updated.ok) throw new Error(updated.message);
  return detectSourceChanges(updated.state, now, fixedClock(now));
}

const claimOf = (s: HomemindState) => s.groupClaims![0];
const items = (s: HomemindState, ids: string[]) => ids.map(id => s.items.find(i => i.id === id)!);

describe('the "update message" demo control', () => {
  it('needs the messages first, edits both to version 2 keeping the old text and posting time, and runs once', () => {
    expect(updateGroupMessages(seedState({ now: MON_10, timezone: ZONE }), MON_11)).toMatchObject({ ok: false, code: 'not_posted' });
    const state = withSignUp();
    expect(updatesLeft(state)).toBe(2);
    const updated = updateGroupMessages(state, MON_11);
    if (!updated.ok) throw new Error('update');
    const [teacher, signUp] = updated.messages;
    expect(teacher).toMatchObject({ id: 'grp-msg-1', version: 2, at: iso(MON_10), editedAt: iso(MON_11) });
    expect(teacher.text).toContain('本周五下午3点');
    expect(teacher.earlier?.[0]).toMatchObject({ version: 1 });
    expect(signUp.text).not.toContain('（苹果');
    expect(updated.remaining).toBe(0);
    expect(updateGroupMessages(updated.state, MON_11)).toMatchObject({ ok: false, code: 'no_more_updates' });
    expect(servicesViewFor(updated.state, 'mom', MON_11).group.updates).toBe(0);
  });
});

describe('stale marking (compared in code)', () => {
  it('apples claimed: the party moves to Friday, apples left the list; 3 items are marked and their owners told', async () => {
    const { box } = await claimed();
    const claim = claimOf(box.state);
    expect(claim.sourceRefs).toEqual([{ id: 'grp-msg-2', version: 1 }, { id: 'grp-msg-1', version: 1 }]);
    const step = update(box.state);
    expect(step.changes).toHaveLength(1);
    const change = step.changes[0];
    expect(change.diffs).toEqual([
      { field: 'eventStart', old: iso(THU_15), new: iso(FRI_15) },
      { field: 'options', removed: ['苹果'], added: [] },
      { field: 'choice', old: 'apples', oldLabel: '苹果', switchTo: 'oranges', switchToLabel: '橙子' }
    ]);
    expect(change.itemIds).toEqual([claim.eventId, ...claim.preparationIds!]);
    const [event, buy] = items(step.state, change.itemIds);
    expect(event.stale).toMatchObject({ changeId: change.id, field: 'start', oldValue: iso(THU_15), newValue: iso(FRI_15) });
    expect(buy.stale).toMatchObject({ field: 'choice', oldValue: 'apples', newValue: 'oranges' });
    expect(event.stale!.reasonZh).toContain('派对从周四');
    // Nothing moved yet.
    expect(event.start).toBe(iso(THU_15));
    // Marked by Homemind in one activity.
    expect(step.state.activity.at(-1)).toMatchObject({ actor: 'homemind', kind: 'source', note: 'marked', ref: change.id });
    // The owners (both parents are asked "Who's taking this?") are told, neutrally; the teen owns nothing here.
    expect(step.alerts.map(a => a.recipientId)).toEqual(['mom', 'dad']);
    expect(step.alerts[0].alert).toMatchObject({ kind: 'stale', staleCount: 2, simulated: true, itemId: event.id });
    // The Why says it was compared in code.
    expect(step.state.whys.find(w => w.id === change.whyId)?.summary).toContain('compared it with the old one in code, not with the model');
  });

  it('the claim is never made twice for a newer version of its message', async () => {
    const { box, adapters } = await claimed();
    const step = update(box.state);
    const again = considerSignUps(step.state, MON_11, adapters);
    expect(again.changed).toBe(false);
  });

  it('reminders of a stale item wait', async () => {
    const { box } = await claimed();
    const buyId = claimOf(box.state).preparationIds![0];
    const wed = at(2026, 11, 11, 17, 50);
    const before = tickReminders(box.state, wed);
    expect(before.deliveries.some(d => d.alert.itemId === buyId)).toBe(true);
    const step = update(box.state);
    const after = tickReminders(step.state, wed);
    expect(after.deliveries.some(d => d.alert.itemId === buyId)).toBe(false);
  });

  it('a wording-only edit updates the versions quietly', async () => {
    const { box } = await claimed();
    const services = servicesOf(box.state);
    const messages = services.group.messages.map(m => (m.id === 'grp-msg-1' ? { ...m, version: 2, text: `${m.text}！` } : m));
    const edited = { ...box.state, services: { ...services, group: { ...services.group, messages } } };
    const step = detectSourceChanges(edited, MON_11, fixedClock(MON_11));
    expect(step.changes).toHaveLength(0);
    expect(claimOf(step.state).sourceRefs).toContainEqual({ id: 'grp-msg-1', version: 2 });
    expect(step.state.items.some(i => i.stale)).toBe(false);
  });

  it('an edited message that can no longer be read is marked unclear, and Apply is refused', async () => {
    const { box, adapters } = await claimed();
    const services = servicesOf(box.state);
    const messages = services.group.messages.map(m => (m.id === 'grp-msg-2' ? { ...m, version: 2, text: '#接龙\n大家随便带点吃的吧' } : m));
    const step = detectSourceChanges({ ...box.state, services: { ...services, group: { ...services.group, messages } } }, MON_11, fixedClock(MON_11));
    expect(step.changes[0].diffs[0].field).toBe('unclear');
    expect(resolveSourceChange(step.state, step.changes[0].id, 'apply', 'mom', MON_11, fixedClock(MON_11), adapters)).toMatchObject({ ok: false, code: 'unclear' });
  });
});

describe('a held card never executes', () => {
  it('a claim card waiting for a tap is held: a parent tap with a valid token and level 4 are both refused', async () => {
    const h = holder(turnOn(withSignUp(), false), MON_10);
    h.box.state = considerSignUps(h.box.state, MON_10, h.adapters).state;
    const cardId = claimOf(h.box.state).cardId!;
    const step = update(h.box.state);
    h.box.state = step.state;
    expect(step.changes[0].cardIds).toEqual([cardId]);
    expect(h.box.state.actionCards.find(c => c.id === cardId)?.held).toMatchObject({ changeId: step.changes[0].id });
    const issued = issueConfirmation(h.box.state, cardId, 'mom', { key: KEY, now: MON_11 }, h.adapters);
    if (!issued.ok) throw new Error('token');
    h.box.now = MON_11;
    expect(await executeAction(h.ref, cardId, { kind: 'tap', memberId: 'mom', token: issued.token }, { adapters: h.adapters, key: KEY, now: () => MON_11 })).toMatchObject({ ok: false, code: 'held' });
    h.box.state = { ...h.box.state, family: { ...h.box.state.family, autonomy: { ...h.box.state.family.autonomy, byArea: { group: 4 } } } };
    expect(await executeAction(h.ref, cardId, { kind: 'auto' }, { adapters: h.adapters, key: KEY, now: () => MON_11 })).toMatchObject({ ok: false, code: 'held' });
    expect(servicesOf(h.box.state).group.messages.some(m => m.from === 'family')).toBe(false);
  });

  it('Keep releases the card; Apply withdraws it and reads the sign-up again', async () => {
    const h = holder(turnOn(withSignUp(), false), MON_10);
    h.box.state = considerSignUps(h.box.state, MON_10, h.adapters).state;
    const cardId = claimOf(h.box.state).cardId!;
    const step = update(h.box.state);
    const kept = resolveSourceChange(step.state, step.changes[0].id, 'keep', 'mom', MON_11, fixedClock(MON_11), h.adapters);
    if (!kept.ok) throw new Error(kept.message);
    expect(kept.state.actionCards.find(c => c.id === cardId)?.held).toBeUndefined();
    const applied = resolveSourceChange(step.state, step.changes[0].id, 'apply', 'mom', MON_11, fixedClock(MON_11), h.adapters);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.state.actionCards.find(c => c.id === cardId)?.status).toBe('cancelled');
    expect(applied.reread).toBe('grp-msg-2');
  });
});

describe('deciding', () => {
  it('Apply (cake, so only the date changed): the event and preparations move one day, the flags clear, no post', async () => {
    const { box, adapters } = await claimed(true);
    const claim = claimOf(box.state);
    const before = items(box.state, [claim.eventId!, ...claim.preparationIds!]);
    const step = update(box.state);
    expect(step.changes[0].diffs.map(d => d.field)).toEqual(['eventStart', 'options']);
    expect(step.changes[0].itemIds).toHaveLength(4);
    const posts = servicesOf(step.state).group.messages.length;
    const applied = resolveSourceChange(step.state, step.changes[0].id, 'apply', 'dad', MON_11, fixedClock(MON_11), adapters);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.correctionCardId).toBeUndefined();
    const after = items(applied.state, before.map(i => i.id));
    after.forEach((item, n) => {
      expect(item.stale).toBeUndefined();
      expect(Date.parse(item.start!) - Date.parse(before[n].start!)).toBe(DAY);
    });
    expect(after[0].end).toBe(iso(FRI_15 + HOUR));
    expect(claimOf(applied.state)).toMatchObject({ eventStart: iso(FRI_15), choice: 'cake', messageVersion: 2 });
    expect(servicesOf(applied.state).group.messages.length).toBe(posts);
    expect(applied.state.sourceChanges![0]).toMatchObject({ status: 'applied', resolvedBy: 'dad' });

    // Undo: back to Thursday, flagged again, the change waits again.
    const undone = undoSourceChange(applied.state, step.changes[0].id, 'mom', MON_11, fixedClock(MON_11));
    if (!undone.ok) throw new Error(undone.message);
    const back = items(undone.state, before.map(i => i.id));
    expect(back[0]).toMatchObject({ start: iso(THU_15), stale: { field: 'start' } });
    expect(claimOf(undone.state).eventStart).toBe(iso(THU_15));
    expect(undone.change.status).toBe('pending');
  });

  it('Apply (apples gone): posts a correction to oranges and swaps the preparations; Undo is then refused', async () => {
    const { box, ref, adapters } = await claimed();
    const step = update(box.state);
    box.now = MON_11;
    const applied = resolveSourceChange(step.state, step.changes[0].id, 'apply', 'mom', MON_11, fixedClock(MON_11), adapters);
    if (!applied.ok) throw new Error(applied.message);
    box.state = applied.state;
    const { ran, after } = await runAuto(box, ref, adapters, applied.correctionCardId!);
    expect(ran.ok).toBe(true);
    expect(servicesOf(box.state).group.messages.at(-1)).toMatchObject({ replyKind: 'correction', text: '更正：诺娅妈妈认领改为橙子（原来是苹果，苹果已不需要）' });
    expect(after!.claim.choice).toBe('oranges');
    const preps = items(box.state, after!.claim.preparationIds!);
    expect(preps.map(p => [p.titleZh, p.start])).toEqual([
      ['为幼儿园派对买橙子（8个小朋友）', iso(at(2026, 11, 12, 18))],
      ['把橙子带到幼儿园', iso(at(2026, 11, 13, 8))]
    ]);
    expect(undoSourceChange(box.state, step.changes[0].id, 'mom', MON_11, fixedClock(MON_11))).toMatchObject({ ok: false, code: 'posted' });
    expect(sourceChangesView(box.state, 'mom', MON_11)[0].undoable).toBe(false);
  });

  it('Keep clears the flags and keeps the old times; Undo flags them again', async () => {
    const { box, adapters } = await claimed(true);
    const step = update(box.state);
    const kept = resolveSourceChange(step.state, step.changes[0].id, 'keep', 'mom', MON_11, fixedClock(MON_11), adapters);
    if (!kept.ok) throw new Error(kept.message);
    const event = kept.state.items.find(i => i.id === claimOf(kept.state).eventId)!;
    expect(event).toMatchObject({ start: iso(THU_15) });
    expect(event.stale).toBeUndefined();
    expect(event.sourceRefs).toContainEqual({ id: 'grp-msg-1', version: 2 });
    expect(kept.state.items.some(i => i.stale)).toBe(false);
    // Nothing to detect any more.
    expect(detectSourceChanges(kept.state, MON_11, fixedClock(MON_11)).changes).toHaveLength(0);
    const undone = undoSourceChange(kept.state, step.changes[0].id, 'mom', MON_11, fixedClock(MON_11));
    if (!undone.ok) throw new Error(undone.message);
    expect(undone.state.items.filter(i => i.stale).length).toBe(4);
  });

  it('Discard takes the items off the board and prepares a post taking the family off the list', async () => {
    const { box, adapters } = await claimed(true);
    const step = update(box.state);
    const discarded = resolveSourceChange(step.state, step.changes[0].id, 'discard', 'mom', MON_11, fixedClock(MON_11), adapters);
    if (!discarded.ok) throw new Error(discarded.message);
    for (const id of step.changes[0].itemIds) expect(discarded.state.items.find(i => i.id === id)?.status).toBe('cancelled');
    const card = discarded.state.actionCards.find(c => c.id === discarded.correctionCardId)!;
    expect(card.payload.text).toBe('更正：诺娅妈妈取消认领蛋糕（消息有变，家里不再参加认领）');
    // Not posted yet (the bridge runs it through the guard), so Undo still works and withdraws it.
    const undone = undoSourceChange(discarded.state, step.changes[0].id, 'mom', MON_11, fixedClock(MON_11));
    if (!undone.ok) throw new Error(undone.message);
    expect(undone.state.actionCards.find(c => c.id === card.id)?.status).toBe('cancelled');
    expect(undone.state.items.find(i => i.id === step.changes[0].itemIds[0])?.status).toBe('open');
  });

  it('parents only; once only; a source activity is not undone item by item', async () => {
    const { box, adapters } = await claimed(true);
    const step = update(box.state);
    const id = step.changes[0].id;
    expect(resolveSourceChange(step.state, id, 'apply', 'maya', MON_11, fixedClock(MON_11), adapters)).toMatchObject({ ok: false, status: 403 });
    const applied = resolveSourceChange(step.state, id, 'apply', 'mom', MON_11, fixedClock(MON_11), adapters);
    if (!applied.ok) throw new Error(applied.message);
    expect(resolveSourceChange(applied.state, id, 'keep', 'mom', MON_11, fixedClock(MON_11), adapters)).toMatchObject({ ok: false, code: 'not_pending' });
    expect(applyChange(applied.state, { kind: 'undo', activityId: applied.activityId! }, 'mom', fixedClock(MON_11))).toMatchObject({ ok: false, status: 409 });
  });
});

describe('who sees what, and the screens', () => {
  it('a Parents-only event leaves no trace in a teen\'s view of the change', async () => {
    const { box, adapters: _a } = await claimed(true);
    const eventId = claimOf(box.state).eventId!;
    const event = box.state.items.find(i => i.id === eventId)!;
    const hidden = applyChange(box.state, { kind: 'edit', itemId: eventId, version: event.version, patch: { visibility: 'parents' } }, 'mom', fixedClock(MON_10));
    if (!hidden.ok) throw new Error(hidden.message);
    const step = update(hidden.state);
    const maya = sourceChangesView(step.state, 'maya', MON_11);
    for (const v of maya) expect(v.items.map(i => i.id)).not.toContain(eventId);
    expect(JSON.stringify(maya)).not.toContain(event.title);
    expect(sourceChangesView(step.state, 'mom', MON_11)[0].items.map(i => i.id)).toContain(eventId);
  });

  it('My day: the card with Apply / Keep / Discard for a parent, the affected items, no buttons for a teen, both languages', async () => {
    const { box } = await claimed();
    const step = update(box.state);
    const screen = (memberId: string, lang: 'en' | 'zh') => {
      const turn = screenTurn('my-day', {
        lang,
        now: iso(MON_11),
        view: viewFor(step.state, memberId) as unknown as HomemindViewData,
        groups: groupsView(step.state),
        sourceChanges: sourceChangesView(step.state, memberId, MON_11)
      });
      expect(A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0]).toBeDefined();
      return turn.jsonl;
    };
    const mom = screen('mom', 'en');
    expect(mom).toContain('The kindergarten changed the party to Friday. 3 items depend on it.');
    expect(mom).toContain('"action":"apply"');
    expect(mom).toContain('Message changed: Thu 11/12 15:00 → Fri 11/13 15:00');
    const dad = screen('dad', 'zh');
    expect(dad).toContain('幼儿园把派对改到了周五。有 3 项与它有关。');
    expect(dad).toContain('应用更改');
    const maya = screen('maya', 'en');
    expect(maya).toContain('A parent decides.');
    expect(maya).not.toContain('"verb":"source-change"');
  });

  it('a held card shows why and has no Confirm button', async () => {
    const h = holder(turnOn(withSignUp(), false), MON_10);
    h.box.state = considerSignUps(h.box.state, MON_10, h.adapters).state;
    const step = update(h.box.state);
    const turn = screenTurn('my-day', { lang: 'en', now: iso(MON_11), view: viewFor(step.state, 'mom') as unknown as HomemindViewData });
    expect(turn.jsonl).toContain('On hold: a message it quotes changed.');
    expect(turn.jsonl).not.toContain('"verb":"confirm-card"');
  });
});
