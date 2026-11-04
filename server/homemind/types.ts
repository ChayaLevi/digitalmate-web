/**
 * Homemind domain types.
 *
 * Plain data only: no imports, no node or browser APIs. The client may import these with
 * `import type` (tests/homemindBoundary.test.ts enforces that). Times are ISO 8601 strings in UTC
 * (`2026-11-04T08:30:00.000Z`); the family's time zone is applied when displaying or seeding.
 */

/** Ids of members, items, rules and so on. Validated with this pattern at the bridge. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type Lang = 'en' | 'zh';
export type AutonomyLevel = 1 | 2 | 3 | 4;
export type MemberRole = 'parent' | 'teen' | 'child';

export interface Member {
  id: string;
  name: string;
  /** Display name in Simplified Chinese, for seeded demo data. */
  nameZh?: string;
  role: MemberRole;
  age?: number;
  hasAccount: boolean;
  lang: Lang;
  /** Local times `HH:MM` in the family's time zone. `from` may be later than `to` (overnight). */
  quietHours?: { from: string; to: string };
}

export interface BackupContact {
  name: string;
  nameZh?: string;
  channel: 'sms' | 'call';
  /** The demo never reaches a real person: the contact is simulated and labeled as such. */
  simulated: boolean;
}

export interface Family {
  id: string;
  name: string;
  nameZh?: string;
  /** IANA zone, for example `Asia/Shanghai`. */
  timezone: string;
  members: Member[];
  backupContact?: BackupContact;
  autonomy: { default: AutonomyLevel; byArea?: Record<string, AutonomyLevel> };
  weekStartsOn: 0 | 1;
  paused: boolean;
}

export type ItemType = 'event' | 'preparation' | 'task';

export type Ownership =
  | { state: 'none' }
  | {
      state: 'open';
      candidateIds: string[];
      /** Set when the owner handed it back. The note is theirs, shown as written. */
      handedBackBy?: string;
      note?: string;
    }
  | { state: 'assigned'; ownerId: string; confirmed: boolean };

/** Weekly repetition. `exceptions` holds local dates (`YYYY-MM-DD`) of cancelled occurrences. */
export interface Recurrence {
  freq: 'weekly';
  /** 0 = Sunday ... 6 = Saturday. */
  byWeekday: number[];
  until?: string;
  exceptions?: string[];
}

export type SourceKind = 'manual' | 'chat' | 'screenshot' | 'email' | 'group' | 'rule' | 'ppma';

export interface ItemSource {
  kind: SourceKind;
  label: string;
  simulated?: boolean;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  /** Display title in Simplified Chinese, for seeded demo data. User-entered items have one language. */
  titleZh?: string;
  notes?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  forMemberIds: string[];
  ownership: Ownership;
  visibility: 'family' | 'parents';
  sensitive: boolean;
  importance: 'normal' | 'critical';
  /** Members this event makes unavailable for its duration (the wedding marks Mom). */
  unavailableMemberIds: string[];
  parentEventId?: string;
  recurrence?: Recurrence;
  status: 'proposed' | 'open' | 'done' | 'cancelled';
  source: ItemSource;
  createdBy: string;
  version: number;
}

export type Tier = 'urgent' | 'timed' | 'summary';

export interface EscalationStep {
  afterMinutes: number;
  to: 'next-parent' | 'both-parents' | 'backup';
}

export interface Reminder {
  id: string;
  itemId: string;
  recipientIds: string[];
  fireAt: string;
  tier: Tier;
  attempts: number;
  status: 'scheduled' | 'sent' | 'acknowledged' | 'cancelled';
  escalation?: EscalationStep[];
}

export interface Preference {
  id: string;
  aboutMemberId?: string;
  text: string;
  textZh?: string;
  reason?: string;
  reasonZh?: string;
  /** Hard preferences (allergies, dietary laws) are never overridden. Soft ones can be. */
  strength: 'hard' | 'soft';
  /** Where it applies, for example `kindergarten-party`. Absent means everywhere. */
  scope?: string;
}

export type RuleTrigger = {
  kind: 'weekly';
  weekday: number;
  /** Local `HH:MM` of the thing the rule prepares for. */
  time: string;
  /** How long before `time` the card is prepared. */
  leadMinutes: number;
};

export interface Rule {
  id: string;
  title: string;
  titleZh?: string;
  trigger: RuleTrigger;
  actionTemplate: { adapter: string; payload: Record<string, unknown> };
  limits: { maxPrice?: number; currency?: string };
  area: string;
  enabled: boolean;
  createdBy: string;
}

export interface ActionCard {
  id: string;
  adapter: string;
  mode: 'real' | 'simulated';
  payload: Record<string, unknown>;
  payloadHash: string;
  status: 'pending' | 'executed' | 'failed' | 'expired' | 'cancelled';
  expiresAt: string;
  whyId: string;
}

/** One item as it was before a change. `before: null` means it did not exist. */
export interface UndoEntry {
  itemId: string;
  before: Item | null;
  /** The item's version right after the change. Undo refuses if it has moved on since. */
  afterVersion: number;
}

/** Enough to restore every item a change touched (cancelling an event also cancels its preparations). */
export interface UndoPatch {
  items: UndoEntry[];
}

export type ActivityKind =
  | 'create'
  | 'edit'
  | 'assign'
  | 'open'
  | 'unassign'
  | 'claim'
  | 'confirm'
  | 'handback'
  | 'done'
  | 'cancel'
  | 'cancel_occurrence'
  | 'approve'
  | 'dismiss'
  | 'undo';

export interface Activity {
  id: string;
  at: string;
  actor: string;
  /** Short neutral English summary, for logs. Screens render from `kind` and the fields below. */
  what: string;
  kind?: ActivityKind;
  itemId?: string;
  /** The member the change names: the new owner, or who handed it back. */
  memberId?: string;
  note?: string;
  /** For `cancel_occurrence`: the local date. For `undo`: the activity that was undone. */
  ref?: string;
  whyId?: string;
  undo?: UndoPatch;
  /** Set once the change has been undone, so it can't be undone twice. */
  undone?: { at: string; by: string; activityId: string };
}

export interface Why {
  id: string;
  summary: string;
  basis: Array<{ kind: string; ref?: string; note: string }>;
  source: 'rule' | 'model' | 'ppma';
  decisionId?: string;
}

export const STATE_SCHEMA_VERSION = 1;

/** Everything the core owns. Persisted as one JSON file by store.ts. */
export interface HomemindState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  family: Family;
  items: Item[];
  reminders: Reminder[];
  preferences: Preference[];
  rules: Rule[];
  actionCards: ActionCard[];
  activity: Activity[];
  whys: Why[];
  /** Demo clock offset, persisted so a bridge restart keeps the jumped time. */
  clockOffsetMs: number;
  /** When the seed was generated (real time, ISO). */
  seededAt: string;
}
