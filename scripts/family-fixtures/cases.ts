/**
 * The family board fixture cases. Each starts from the seed (Homemind's demo seed in the v1 shape) and
 * lists ops in seq order with the member who wrote them and the outcome a human expects. The generator
 * runs them through the core and fails if the core does anything else, so a case always tests what its
 * name says.
 *
 * Seed facts the cases rely on (every seed item is at version 1):
 *   family:  pickup-today (event, no owner), swim-today (event, Mom's), piano-tomorrow (event, Maya's
 *            lesson, no owner), library-books (task, open to Mom, Dad, Maya), pickup-tuesday (event, Mom's),
 *            family-dinner (event) with its preparation family-dinner-flowers (open to Mom, Dad)
 *   parents: counselor-meeting (event, Mom's)
 *   members: mom, dad (parents), maya (teen), noa (child, no account)
 */
import type { ChangeErrorCode } from '../../server/homemind/core';
import type { Scope } from './adapter';

export type Expect = 'applied' | ChangeErrorCode | 'stop';
export type Member = 'mom' | 'dad' | 'maya' | 'noa';

export interface Step {
  by: Member;
  /** Default `family`. */
  scope?: Scope;
  /** The op without `v`, `opId` and `at` (the builder adds them). */
  op: { kind: string; [field: string]: unknown };
  expect: Expect;
  /** Override the op format version (D15 cases). */
  v?: number;
  /** Reuse an earlier step's op id (1-based step number). */
  sameOpIdAs?: number;
}

export interface CaseDef {
  name: string;
  /** The fixture file it goes to: `board-<group>.json`. */
  group: string;
  covers: string[];
  description: string;
  steps: Step[];
}

/** What PLAN.md S.2 asks the fixtures to cover. The generator fails if one is missing. */
export const REQUIRED_COVERAGE = ['create', 'assign', 'claim', 'handback', 'done', 'undo', 'stale', 'cross-scope', 'visibility-change'] as const;

export const MIN_CASES = 60;

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ kind: 'create', item: { id, type: 'task', title, ...extra } });
const event = (id: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  kind: 'create',
  item: { id, type: 'event', title, start, end, ...extra }
});
const prep = (id: string, title: string, parentEventId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'create',
  item: { id, type: 'preparation', title, parentEventId, ...extra }
});
const on = (kind: string, itemId: string, version: number, extra: Record<string, unknown> = {}) => ({ kind, itemId, version, ...extra });
/** Undo the op of an earlier step of the same case (1-based), by its op id. */
const undo = (step: number) => ({ kind: 'undo', targetStep: step });

const GROUP_SOURCE = { kind: 'group', label: 'Kindergarten parents group' };

export const CASES: CaseDef[] = [
  // ------------------------------------------------------------------ create
  {
    name: 'create-task',
    group: 'create',
    covers: ['create'],
    description: 'Mom adds a task to the family board. The item id comes from the op (D10), createdBy from the log entry (D12).',
    steps: [{ by: 'mom', op: task('buy-milk', 'Buy milk'), expect: 'applied' }]
  },
  {
    name: 'create-event-with-preparation',
    group: 'create',
    covers: ['create'],
    description: 'Mom adds an event and Dad adds a preparation under it.',
    steps: [
      { by: 'mom', op: event('school-play', 'School play', '2026-11-19T15:00:00.000Z', '2026-11-19T16:30:00.000Z', { forMemberIds: ['maya'] }), expect: 'applied' },
      { by: 'dad', op: prep('school-play-costume', 'Sew the costume', 'school-play', { start: '2026-11-18T18:00:00.000Z' }), expect: 'applied' }
    ]
  },
  {
    name: 'create-assigned-to-self-is-confirmed',
    group: 'create',
    covers: ['create', 'assign'],
    description: 'An item created assigned to its creator is confirmed; assigned to someone else it is not.',
    steps: [
      { by: 'dad', op: task('fix-bike', 'Fix the bike', { ownership: { state: 'assigned', ownerId: 'dad' } }), expect: 'applied' },
      { by: 'dad', op: task('call-plumber', 'Call the plumber', { ownership: { state: 'assigned', ownerId: 'mom' } }), expect: 'applied' }
    ]
  },
  {
    name: 'create-parents-item-by-parent',
    group: 'create',
    covers: ['create', 'cross-scope'],
    description: 'Dad adds a parents-only task. Only the parents partition changes; the family partition hash is the same on a teen device.',
    steps: [{ by: 'dad', scope: 'parents', op: task('gift-for-maya', "Buy Maya's birthday gift"), expect: 'applied' }]
  },
  {
    name: 'create-parents-item-by-teen-rejected',
    group: 'create',
    covers: ['create', 'cross-scope'],
    description: 'Only a parent creates in parents (the server also refuses a teen device the scope; the reducer refuses it anyway).',
    steps: [{ by: 'maya', scope: 'parents', op: task('maya-secret', 'Not allowed'), expect: 'forbidden' }]
  },
  {
    name: 'create-duplicate-id-rejected',
    group: 'create',
    covers: ['create'],
    description: 'A create whose item id already exists in the scope is a conflict.',
    steps: [{ by: 'mom', op: task('library-books', 'Same id again'), expect: 'conflict' }]
  },
  {
    name: 'create-by-member-without-account-rejected',
    group: 'create',
    covers: ['create'],
    description: 'A member without an account cannot act.',
    steps: [{ by: 'noa', op: task('noa-task', 'Draw a picture'), expect: 'forbidden' }]
  },
  {
    name: 'create-preparation-without-event-rejected',
    group: 'create',
    covers: ['create'],
    description: 'A preparation must name an event that exists; a task under an event is invalid.',
    steps: [
      { by: 'mom', op: prep('orphan-prep', 'Pack', 'no-such-event'), expect: 'not_found' },
      { by: 'mom', op: task('task-under-event', 'Not a preparation', { parentEventId: 'family-dinner' }), expect: 'invalid' }
    ]
  },
  {
    name: 'create-proposed-then-approve',
    group: 'create',
    covers: ['create', 'approve'],
    description: 'Items from a group message are proposed. Approving the event approves its proposed preparation in the same op.',
    steps: [
      { by: 'mom', op: event('class-trip', 'Class trip to the zoo', '2026-11-20T06:00:00.000Z', '2026-11-20T11:00:00.000Z', { source: GROUP_SOURCE }), expect: 'applied' },
      { by: 'mom', op: prep('class-trip-snack', 'Pack a snack', 'class-trip', { source: GROUP_SOURCE }), expect: 'applied' },
      { by: 'dad', op: on('approve', 'class-trip', 1), expect: 'applied' }
    ]
  },
  {
    name: 'dismiss-proposed',
    group: 'create',
    covers: ['create', 'dismiss'],
    description: 'A proposed item is dismissed (kept as cancelled); dismissing it again is a conflict.',
    steps: [
      { by: 'mom', op: task('paint-fence', 'Paint the fence', { proposed: true }), expect: 'applied' },
      { by: 'dad', op: on('dismiss', 'paint-fence', 1), expect: 'applied' },
      { by: 'dad', op: on('dismiss', 'paint-fence', 2), expect: 'conflict' }
    ]
  },

  // ------------------------------------------------------------------ ownership
  {
    name: 'assign-then-confirm',
    group: 'ownership',
    covers: ['assign', 'confirm'],
    description: 'Mom assigns the library books to Dad (not confirmed); Dad confirms.',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'dad', op: on('confirm', 'library-books', 2), expect: 'applied' }
    ]
  },
  {
    name: 'confirm-by-non-owner-rejected',
    group: 'ownership',
    covers: ['assign', 'confirm'],
    description: 'Only the owner confirms.',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'maya', op: on('confirm', 'library-books', 2), expect: 'forbidden' }
    ]
  },
  {
    name: 'assign-to-member-without-account-rejected',
    group: 'ownership',
    covers: ['assign'],
    description: 'Noa has no account and cannot own an item.',
    steps: [{ by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'noa' }), expect: 'invalid' }]
  },
  {
    name: 'assign-parents-item-to-teen-rejected',
    group: 'ownership',
    covers: ['assign', 'cross-scope'],
    description: 'A parents item can only be owned by a parent: assigning it to Maya is invalid, to Dad it works.',
    steps: [
      { by: 'mom', scope: 'parents', op: on('assign', 'counselor-meeting', 1, { ownerId: 'maya' }), expect: 'invalid' },
      { by: 'mom', scope: 'parents', op: on('assign', 'counselor-meeting', 1, { ownerId: 'dad' }), expect: 'applied' }
    ]
  },
  {
    name: 'assign-same-owner-rejected',
    group: 'ownership',
    covers: ['assign'],
    description: 'Assigning to the member who already owns it is a conflict.',
    steps: [{ by: 'dad', op: on('assign', 'swim-today', 1, { ownerId: 'mom' }), expect: 'conflict' }]
  },
  {
    name: 'claim-open-task',
    group: 'ownership',
    covers: ['claim'],
    description: 'Maya takes the open library-books task ("I\'ll take it"): assigned to her, confirmed.',
    steps: [{ by: 'maya', op: on('claim', 'library-books', 1), expect: 'applied' }]
  },
  {
    name: 'claim-race-first-wins',
    group: 'ownership',
    covers: ['claim', 'stale'],
    description: 'Maya and Dad both tap "I\'ll take it" on version 1. Maya\'s op has the lower seq and wins; Dad\'s is stale on every device (D8).',
    steps: [
      { by: 'maya', op: on('claim', 'library-books', 1), expect: 'applied' },
      { by: 'dad', op: on('claim', 'library-books', 1), expect: 'stale' }
    ]
  },
  {
    name: 'claim-owned-by-other-rejected',
    group: 'ownership',
    covers: ['claim'],
    description: 'Dad claims swim-today at its current version, but Mom owns it: conflict.',
    steps: [{ by: 'dad', op: on('claim', 'swim-today', 1), expect: 'conflict' }]
  },
  {
    name: 'handback-with-note-then-claim',
    group: 'ownership',
    covers: ['handback', 'claim'],
    description: 'Mom hands swim-today back with a note; it opens to everyone else who can own it; Dad takes it.',
    steps: [
      { by: 'mom', op: on('handback', 'swim-today', 1, { note: 'I have a meeting at 17:00' }), expect: 'applied' },
      { by: 'dad', op: on('claim', 'swim-today', 2), expect: 'applied' }
    ]
  },
  {
    name: 'handback-by-non-owner-rejected',
    group: 'ownership',
    covers: ['handback'],
    description: 'Only the owner hands an item back.',
    steps: [{ by: 'dad', op: on('handback', 'swim-today', 1), expect: 'forbidden' }]
  },
  {
    name: 'open-then-unassign',
    group: 'ownership',
    covers: ['open', 'unassign'],
    description: 'Mom asks who is taking pickup-today, naming Dad and Maya; then clears it; clearing again is a conflict.',
    steps: [
      { by: 'mom', op: on('open', 'pickup-today', 1, { candidateIds: ['dad', 'maya'] }), expect: 'applied' },
      { by: 'mom', op: on('unassign', 'pickup-today', 2), expect: 'applied' },
      { by: 'mom', op: on('unassign', 'pickup-today', 3), expect: 'conflict' }
    ]
  },
  {
    name: 'open-with-reason-in-family',
    group: 'ownership',
    covers: ['open'],
    description: 'An open with a reason that names a family event making Dad unavailable is kept on the item.',
    steps: [
      { by: 'dad', op: event('dad-work-trip', 'Work trip', '2026-11-11T13:00:00.000Z', '2026-11-11T18:00:00.000Z', { unavailableMemberIds: ['dad'] }), expect: 'applied' },
      {
        by: 'mom',
        op: on('open', 'pickup-today', 1, { reason: { kind: 'unavailable', memberId: 'dad', eventId: 'dad-work-trip', date: '2026-11-11' } }),
        expect: 'applied'
      }
    ]
  },

  // ------------------------------------------------------------------ done and cancel
  {
    name: 'claim-then-done',
    group: 'done',
    covers: ['claim', 'done'],
    description: 'Maya takes the library books and marks them done.',
    steps: [
      { by: 'maya', op: on('claim', 'library-books', 1), expect: 'applied' },
      { by: 'maya', op: on('done', 'library-books', 2), expect: 'applied' }
    ]
  },
  {
    name: 'done-twice-rejected',
    group: 'done',
    covers: ['done'],
    description: 'Marking a done item done again, at its current version, is a conflict.',
    steps: [
      { by: 'dad', op: on('done', 'library-books', 1), expect: 'applied' },
      { by: 'mom', op: on('done', 'library-books', 2), expect: 'conflict' }
    ]
  },
  {
    name: 'done-proposed-rejected',
    group: 'done',
    covers: ['done'],
    description: 'A proposed item must be approved before it is done.',
    steps: [
      { by: 'mom', op: task('bake-cake', 'Bake a cake', { source: GROUP_SOURCE }), expect: 'applied' },
      { by: 'mom', op: on('done', 'bake-cake', 1), expect: 'conflict' }
    ]
  },
  {
    name: 'done-after-cancel-rejected',
    group: 'done',
    covers: ['done', 'cancel'],
    description: 'Mom removes the task; Maya marks it done at the new version: conflict, it was removed.',
    steps: [
      { by: 'mom', op: on('cancel', 'library-books', 1), expect: 'applied' },
      { by: 'maya', op: on('done', 'library-books', 2), expect: 'conflict' }
    ]
  },
  {
    name: 'recurring-cancel-occurrence',
    group: 'done',
    covers: ['create', 'cancel_occurrence', 'done'],
    description: 'A weekly Wednesday swim lesson: one occurrence is cancelled; the same date again is a conflict; a Thursday is no occurrence; a repeating item is never done as a whole.',
    steps: [
      {
        by: 'mom',
        op: event('swim-weekly', 'Swimming', '2026-11-11T15:30:00.000Z', '2026-11-11T16:30:00.000Z', { recurrence: { freq: 'weekly', byWeekday: [3] } }),
        expect: 'applied'
      },
      { by: 'mom', op: on('cancel_occurrence', 'swim-weekly', 1, { date: '2026-11-18' }), expect: 'applied' },
      { by: 'dad', op: on('cancel_occurrence', 'swim-weekly', 2, { date: '2026-11-18' }), expect: 'conflict' },
      { by: 'dad', op: on('cancel_occurrence', 'swim-weekly', 2, { date: '2026-11-19' }), expect: 'invalid' },
      { by: 'dad', op: on('done', 'swim-weekly', 2), expect: 'invalid' }
    ]
  },
  {
    name: 'cancel-event-cancels-preparations',
    group: 'done',
    covers: ['cancel'],
    description: 'Removing an event removes its preparations in the same op.',
    steps: [{ by: 'mom', op: on('cancel', 'family-dinner', 1), expect: 'applied' }]
  },

  // ------------------------------------------------------------------ undo
  {
    name: 'undo-assign',
    group: 'undo',
    covers: ['assign', 'undo'],
    description: 'Mom assigns the library books to Dad, then undoes it: the old content comes back under a new version (3).',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'undo-twice-rejected',
    group: 'undo',
    covers: ['undo'],
    description: 'An op is undone once.',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'conflict' }
    ]
  },
  {
    name: 'undo-after-later-change-stale',
    group: 'undo',
    covers: ['undo', 'stale'],
    description: 'Undo is version-checked, never a blind restore (D8): after Dad confirmed, undoing the assign is stale.',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'dad', op: on('confirm', 'library-books', 2), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'stale' }
    ]
  },
  {
    name: 'undo-create-removes-item',
    group: 'undo',
    covers: ['create', 'undo'],
    description: 'Undoing a create removes the item.',
    steps: [
      { by: 'dad', op: task('wash-car', 'Wash the car'), expect: 'applied' },
      { by: 'dad', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'undo-create-with-child-rejected',
    group: 'undo',
    covers: ['create', 'undo'],
    description: 'An event cannot be un-created once something was added under it.',
    steps: [
      { by: 'mom', op: event('bbq', 'Barbecue', '2026-11-21T10:00:00.000Z', '2026-11-21T14:00:00.000Z'), expect: 'applied' },
      { by: 'dad', op: prep('bbq-coal', 'Buy coal', 'bbq'), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'conflict' }
    ]
  },
  {
    name: 'undo-of-another-members-op',
    group: 'undo',
    covers: ['assign', 'undo'],
    description: "Maya cannot undo Mom's change; Dad, a parent, can.",
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'maya' }), expect: 'applied' },
      { by: 'maya', op: undo(1), expect: 'forbidden' },
      { by: 'dad', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'undo-cancel-restores-preparations',
    group: 'undo',
    covers: ['cancel', 'undo'],
    description: 'Undoing the removal of an event brings back the event and its preparation in one op.',
    steps: [
      { by: 'mom', op: on('cancel', 'family-dinner', 1), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'undo-unknown-op-rejected',
    group: 'undo',
    covers: ['undo'],
    description: 'Undo of an op id that was never applied (here: a rejected op) finds nothing.',
    steps: [
      { by: 'dad', op: on('claim', 'swim-today', 1), expect: 'conflict' },
      { by: 'dad', op: undo(1), expect: 'not_found' }
    ]
  },

  // ------------------------------------------------------------------ stale versions
  {
    name: 'edit-stale-version',
    group: 'stale',
    covers: ['edit', 'stale'],
    description: 'Mom and Dad edit pickup-today from version 1. Mom has the lower seq; Dad is stale and retries on version 2.',
    steps: [
      { by: 'mom', op: on('edit', 'pickup-today', 1, { patch: { title: 'Kindergarten pickup (early)' } }), expect: 'applied' },
      { by: 'dad', op: on('edit', 'pickup-today', 1, { patch: { notes: 'Bring the scooter' } }), expect: 'stale' },
      { by: 'dad', op: on('edit', 'pickup-today', 2, { patch: { notes: 'Bring the scooter' } }), expect: 'applied' }
    ]
  },
  {
    name: 'assign-and-done-race',
    group: 'stale',
    covers: ['assign', 'done', 'stale'],
    description: 'Dad marks the task done while Mom assigns it, both from version 1: whichever has the lower seq wins.',
    steps: [
      { by: 'dad', op: on('done', 'library-books', 1), expect: 'applied' },
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'maya' }), expect: 'stale' }
    ]
  },
  {
    name: 'edit-clears-and-checks-times',
    group: 'stale',
    covers: ['edit'],
    description: 'An edit may clear a time with an empty string; an end before the start is invalid.',
    steps: [
      { by: 'mom', op: on('edit', 'library-books', 1, { patch: { start: '', allDay: false } }), expect: 'applied' },
      { by: 'mom', op: on('edit', 'pickup-today', 1, { patch: { end: '2026-11-11T14:00:00.000Z' } }), expect: 'invalid' }
    ]
  },

  // ------------------------------------------------------------------ scopes (D11)
  {
    name: 'family-op-on-parents-item-rejected',
    group: 'scopes',
    covers: ['cross-scope', 'claim'],
    description: 'A family op naming a parents item finds nothing (not_found, never forbidden, so no trace leaks).',
    steps: [{ by: 'dad', op: on('claim', 'counselor-meeting', 1), expect: 'not_found' }]
  },
  {
    name: 'family-preparation-under-parents-event-rejected',
    group: 'scopes',
    covers: ['cross-scope', 'create'],
    description: 'A family preparation cannot hang under a parents event.',
    steps: [{ by: 'mom', op: prep('counselor-notes', 'Write questions', 'counselor-meeting'), expect: 'not_found' }]
  },
  {
    name: 'family-open-reason-names-parents-event-rejected',
    group: 'scopes',
    covers: ['cross-scope', 'open'],
    description: "Mom's parents-only appointment makes her unavailable. A family open may not cite it; the parent device writes the family op without the reason.",
    steps: [
      {
        by: 'mom',
        scope: 'parents',
        op: event('mom-doctor', 'Doctor appointment', '2026-11-11T14:00:00.000Z', '2026-11-11T15:30:00.000Z', { unavailableMemberIds: ['mom'] }),
        expect: 'applied'
      },
      {
        by: 'mom',
        op: on('open', 'pickup-today', 1, { reason: { kind: 'unavailable', memberId: 'mom', eventId: 'mom-doctor', date: '2026-11-11' } }),
        expect: 'invalid'
      },
      { by: 'mom', op: on('open', 'pickup-today', 1, { candidateIds: ['dad', 'maya'] }), expect: 'applied' }
    ]
  },
  {
    name: 'family-undo-of-parents-op-rejected',
    group: 'scopes',
    covers: ['cross-scope', 'undo'],
    description: 'An undo in family cannot name a parents op; the same undo in parents works.',
    steps: [
      { by: 'dad', scope: 'parents', op: on('assign', 'counselor-meeting', 1, { ownerId: 'dad' }), expect: 'applied' },
      { by: 'dad', op: undo(1), expect: 'not_found' },
      { by: 'dad', scope: 'parents', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'parents-op-on-family-item-rejected',
    group: 'scopes',
    covers: ['cross-scope', 'create', 'claim'],
    description: 'The owner\'s choice for v1: no references across scopes in either direction. A parents preparation cannot hang under a family event, and a parents op cannot change a family item.',
    steps: [
      { by: 'mom', scope: 'parents', op: prep('dinner-gift', 'Secret gift for Grandma', 'family-dinner'), expect: 'not_found' },
      { by: 'mom', scope: 'parents', op: on('claim', 'library-books', 1), expect: 'not_found' }
    ]
  },
  {
    name: 'same-id-in-both-scopes-allowed',
    group: 'scopes',
    covers: ['cross-scope', 'create'],
    description: 'A teen device cannot see parents ids, so a family create whose id exists in parents must be accepted on every device, or the devices would diverge. Ids are minted as UUIDs in practice.',
    steps: [{ by: 'maya', op: task('counselor-meeting', 'A family task that happens to reuse the id'), expect: 'applied' }]
  },

  // ------------------------------------------------------------------ visibility change (D11)
  {
    name: 'move-family-item-to-parents',
    group: 'visibility',
    covers: ['visibility-change', 'cancel', 'create'],
    description: 'Mom makes the Tuesday pickup parents-only: a cancel in family (the tombstone) and a new item in parents.',
    steps: [
      { by: 'mom', op: on('cancel', 'pickup-tuesday', 1), expect: 'applied' },
      {
        by: 'mom',
        scope: 'parents',
        op: event('pickup-tuesday-p', 'Kindergarten pickup', '2026-11-17T14:30:00.000Z', '2026-11-17T15:00:00.000Z', {
          forMemberIds: ['noa'],
          importance: 'critical',
          ownership: { state: 'assigned', ownerId: 'mom' }
        }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'move-parents-item-to-family',
    group: 'visibility',
    covers: ['visibility-change', 'cancel', 'create'],
    description: 'Mom shares the counselor meeting with the family under a neutral title: a cancel in parents and a new item in family.',
    steps: [
      { by: 'mom', scope: 'parents', op: on('cancel', 'counselor-meeting', 1), expect: 'applied' },
      {
        by: 'mom',
        op: event('school-meeting', 'Meeting at school', '2026-11-13T08:00:00.000Z', '2026-11-13T09:00:00.000Z', { ownership: { state: 'assigned', ownerId: 'mom' } }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'edit-cannot-change-visibility',
    group: 'visibility',
    covers: ['visibility-change', 'edit'],
    description: 'An edit that tries to set visibility is invalid (v1 ops have no visibility field; the schema refuses it too).',
    steps: [{ by: 'mom', op: on('edit', 'pickup-today', 1, { patch: { visibility: 'parents' } }), expect: 'invalid' }]
  },
  {
    name: 'move-event-with-preparation-to-parents',
    group: 'visibility',
    covers: ['visibility-change', 'cancel', 'create'],
    description: 'Moving an event moves its preparation too: one cancel in family takes both, then both are created in parents.',
    steps: [
      { by: 'dad', op: on('cancel', 'family-dinner', 1), expect: 'applied' },
      { by: 'dad', scope: 'parents', op: event('dinner-p', "Family dinner at Grandma's", '2026-11-15T16:00:00.000Z', '2026-11-15T18:00:00.000Z'), expect: 'applied' },
      { by: 'dad', scope: 'parents', op: prep('dinner-p-flowers', 'Buy flowers for Grandma', 'dinner-p', { start: '2026-11-15T10:00:00.000Z' }), expect: 'applied' }
    ]
  },

  // ------------------------------------------------------------------ scope helpers (C1)
  // These ops are what HOPA's `core/family` scope helpers write (`VisibilityMove`, `BusyDerivation`);
  // its tests rebuild them and compare, so the helpers and the fixtures cannot drift apart.
  {
    name: 'derive-busy-event-for-family',
    group: 'scopes',
    covers: ['cross-scope', 'create', 'open'],
    description:
      "D11: Mom's doctor appointment is parents-only. Her device derives a family event that says only that she is busy (no title, no notes), and a family open may cite that one.",
    steps: [
      {
        by: 'mom',
        scope: 'parents',
        op: event('mom-doctor', 'Doctor appointment', '2026-11-11T14:00:00.000Z', '2026-11-11T15:30:00.000Z', {
          notes: 'Second opinion, bring the scans',
          unavailableMemberIds: ['mom']
        }),
        expect: 'applied'
      },
      {
        by: 'mom',
        op: event('mom-busy', 'Busy', '2026-11-11T14:00:00.000Z', '2026-11-11T15:30:00.000Z', { unavailableMemberIds: ['mom'] }),
        expect: 'applied'
      },
      {
        by: 'mom',
        op: on('open', 'pickup-today', 1, { reason: { kind: 'unavailable', memberId: 'mom', eventId: 'mom-busy', date: '2026-11-11' } }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'move-open-task-to-parents-narrows-candidates',
    group: 'visibility',
    covers: ['visibility-change', 'cancel', 'create'],
    description: 'Moving a task open to Mom, Dad and Maya into parents keeps only the parents as candidates, and keeps its time, all-day flag and source.',
    steps: [
      { by: 'dad', op: on('cancel', 'library-books', 1), expect: 'applied' },
      {
        by: 'dad',
        scope: 'parents',
        op: task('library-books-p', 'Return the library books', {
          start: '2026-11-11T22:00:00.000Z',
          allDay: true,
          ownership: { state: 'open', candidateIds: ['mom', 'dad'] },
          source: { kind: 'manual', label: 'Added by Mom' }
        }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'move-task-owned-by-teen-opens-to-parents',
    group: 'visibility',
    covers: ['visibility-change', 'assign', 'cancel', 'create'],
    description: 'Maya cannot own a parents item, so moving her task into parents opens it to the parents instead of dropping it silently.',
    steps: [
      { by: 'mom', op: on('assign', 'library-books', 1, { ownerId: 'maya' }), expect: 'applied' },
      { by: 'mom', op: on('cancel', 'library-books', 2), expect: 'applied' },
      {
        by: 'mom',
        scope: 'parents',
        op: task('library-books-p', 'Return the library books', {
          start: '2026-11-11T22:00:00.000Z',
          allDay: true,
          ownership: { state: 'open' },
          source: { kind: 'manual', label: 'Added by Mom' }
        }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'move-recurring-event-keeps-exceptions',
    group: 'visibility',
    covers: ['visibility-change', 'cancel_occurrence', 'cancel', 'create'],
    description: 'A weekly event moves with its repetition and its cancelled dates.',
    steps: [
      {
        by: 'mom',
        op: event('swim-weekly', 'Swimming', '2026-11-11T15:30:00.000Z', '2026-11-11T16:30:00.000Z', {
          recurrence: { freq: 'weekly', byWeekday: [3] }
        }),
        expect: 'applied'
      },
      { by: 'mom', op: on('cancel_occurrence', 'swim-weekly', 1, { date: '2026-11-18' }), expect: 'applied' },
      { by: 'mom', op: on('cancel', 'swim-weekly', 2), expect: 'applied' },
      {
        by: 'mom',
        scope: 'parents',
        op: event('swim-weekly-p', 'Swimming', '2026-11-11T15:30:00.000Z', '2026-11-11T16:30:00.000Z', {
          recurrence: { freq: 'weekly', byWeekday: [3], exceptions: ['2026-11-18'] },
          source: { kind: 'manual', label: 'Added by Mom' }
        }),
        expect: 'applied'
      }
    ]
  },
  {
    name: 'undo-a-move-is-two-undos',
    group: 'visibility',
    covers: ['visibility-change', 'undo'],
    description: 'Undoing a move undoes its two ops, newest first: the parents copy goes, then the family item comes back.',
    steps: [
      { by: 'mom', op: on('cancel', 'pickup-tuesday', 1), expect: 'applied' },
      {
        by: 'mom',
        scope: 'parents',
        op: event('pickup-tuesday-p', 'Kindergarten pickup', '2026-11-17T14:30:00.000Z', '2026-11-17T15:00:00.000Z', {
          forMemberIds: ['noa'],
          importance: 'critical',
          ownership: { state: 'assigned', ownerId: 'mom' },
          source: { kind: 'manual', label: 'Added by Mom' }
        }),
        expect: 'applied'
      },
      { by: 'mom', scope: 'parents', op: undo(2), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'weekly-event-near-midnight-uses-family-zone',
    group: 'time',
    covers: ['cancel_occurrence', 'time-zone'],
    description:
      "A weekly Thursday and Friday event that starts at 00:30 on Friday in Jerusalem, which is still Thursday in UTC. Its first occurrence is Friday the 13th in the family's zone, so Thursday the 12th is not an occurrence: a reducer that read dates in UTC (or in the device's zone) would accept it.",
    steps: [
      {
        by: 'mom',
        op: event('night-shift', 'Night shift', '2026-11-12T22:30:00.000Z', '2026-11-13T04:30:00.000Z', {
          recurrence: { freq: 'weekly', byWeekday: [4, 5] }
        }),
        expect: 'applied'
      },
      { by: 'mom', op: on('cancel_occurrence', 'night-shift', 1, { date: '2026-11-12' }), expect: 'invalid' },
      { by: 'mom', op: on('cancel_occurrence', 'night-shift', 1, { date: '2026-11-13' }), expect: 'applied' }
    ]
  },

  // ------------------------------------------------------------------ split
  {
    name: 'split-task-with-minted-ids',
    group: 'split',
    covers: ['split'],
    description: 'The library books are really two errands. The first part replaces the task; the second is a new item with the id the op carries (D10), open to the same people.',
    steps: [{ by: 'mom', op: on('split', 'library-books', 1, { parts: [{ title: 'Return the picture books' }, { id: 'library-dvds', title: 'Return the DVDs' }] }), expect: 'applied' }]
  },
  {
    name: 'split-then-undo',
    group: 'split',
    covers: ['split', 'undo'],
    description: 'One undo puts a split back: the first part regains the old title, the new part is removed.',
    steps: [
      { by: 'mom', op: on('split', 'library-books', 1, { parts: [{ title: 'Return the picture books' }, { id: 'library-dvds', title: 'Return the DVDs' }] }), expect: 'applied' },
      { by: 'mom', op: undo(1), expect: 'applied' }
    ]
  },
  {
    name: 'split-part-id-taken-rejected',
    group: 'split',
    covers: ['split'],
    description: 'A split part whose id already exists in the scope is a conflict; an event cannot be split.',
    steps: [
      { by: 'mom', op: on('split', 'library-books', 1, { parts: [{ title: 'Picture books' }, { id: 'pickup-today', title: 'DVDs' }] }), expect: 'conflict' },
      { by: 'mom', op: on('split', 'pickup-today', 1, { parts: [{ title: 'Part one' }, { id: 'pickup-two', title: 'Part two' }] }), expect: 'invalid' }
    ]
  },

  // ------------------------------------------------------------------ versioning (D15) and op ids
  {
    name: 'unknown-kind-stops-replay',
    group: 'versioning',
    covers: ['versioned-ops'],
    description: 'An op kind this reader does not know stops replay at its seq; later ops are not applied (D15).',
    steps: [
      { by: 'mom', op: task('before-stop', 'Applied before the stop'), expect: 'applied' },
      { by: 'mom', op: { kind: 'archive', itemId: 'pickup-today', version: 1 }, expect: 'stop' },
      { by: 'mom', op: task('after-stop', 'Never applied'), expect: 'stop' }
    ]
  },
  {
    name: 'higher-version-stops-replay',
    group: 'versioning',
    covers: ['versioned-ops'],
    description: 'An op with a higher `v` stops replay at its seq (D15).',
    steps: [
      { by: 'dad', op: task('v2-task', 'Written by a newer client'), v: 2, expect: 'stop' },
      { by: 'dad', op: task('after-v2', 'Never applied'), expect: 'stop' }
    ]
  },
  {
    name: 'reused-op-id-rejected',
    group: 'versioning',
    covers: ['create'],
    description: 'An op id names its activity, so a second op with the same id is a conflict (the server refuses it first; the reducer is safe anyway).',
    steps: [
      { by: 'mom', op: task('first-op', 'First'), expect: 'applied' },
      { by: 'mom', op: task('second-op', 'Second, same op id'), sameOpIdAs: 1, expect: 'conflict' }
    ]
  }
];
