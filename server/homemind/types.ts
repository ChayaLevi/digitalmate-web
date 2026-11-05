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

/**
 * Why Homemind opened an item, rather than a person. Only availability.ts sets it. A member who
 * can't see the event gets the item without the reason (visibility.ts).
 */
export interface OpenReason {
  kind: 'unavailable';
  /** The owner who is unavailable then. */
  memberId: string;
  /** The event that makes them unavailable. */
  eventId: string;
  /** Local date `YYYY-MM-DD` of the clashing occurrence. */
  date: string;
}

export type Ownership =
  | { state: 'none' }
  | {
      state: 'open';
      candidateIds: string[];
      /** Set when the owner handed it back. The note is theirs, shown as written. */
      handedBackBy?: string;
      note?: string;
      reason?: OpenReason;
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

/**
 * What goes over `GET /api/homemind/events`, one SSE frame each (`event:` is `event`, `data:` is the
 * JSON `data`). The client imports this type, so it lives here.
 */
export type StreamMessage =
  /** First frame of every connection. The client refreshes its screen on it, which covers anything missed while it was away. */
  | { event: 'hello'; data: { memberId: string; now: string } }
  /** `item` is `null` when the item left this member's view or no longer exists. Already redacted for this member. */
  | { event: 'item.changed'; data: { itemId: string; item: Item | null } }
  /** Something this member should know now (T3.3: assigned to you, "Who's taking this?"). T4.1 adds reminders and escalation. */
  | { event: 'alert'; data: HomemindAlert }
  /** The demo was reset: forget everything shown. */
  | { event: 'demo.reset'; data: Record<string, never> };

export type AlertKind = 'assigned' | 'open';

/**
 * A live alert for one member, shown by the client's AlertBanner. It names no other member's
 * failings (neutral wording is the client's job too). For a sensitive item the title is left out, so
 * the banner says only "You have a reminder".
 */
export interface HomemindAlert {
  /** Stable for one item version and kind, so a repeat can be ignored: `<itemId>.<version>.<kind>`. */
  id: string;
  kind: AlertKind;
  itemId: string;
  /** The item's version when the alert was made, for the banner's own buttons ("I'm on it", "I'll take it"). */
  itemVersion: number;
  tier: Tier;
  at: string;
  /** Who made the change: a member id. */
  byId: string;
  byName: string;
  byNameZh?: string;
  /** Absent when the item is sensitive. */
  title?: string;
  titleZh?: string;
  sensitive: boolean;
}
