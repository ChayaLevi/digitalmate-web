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
  /** Minutes after the reminder's first attempt (`firstAt`). */
  afterMinutes: number;
  to: 'next-parent' | 'both-parents' | 'backup';
}

/**
 * What a reminder asks of its recipients:
 *   heads-up  the owner already said "I'm on it": one note before it starts
 *   confirm   assigned but not confirmed: "Please confirm"
 *   open      nobody has it yet: "Who's taking this?"
 */
export type ReminderAsk = 'heads-up' | 'confirm' | 'open';

/**
 * One reminder per occurrence of a timed item (reminders.ts keeps them in line with the board).
 * Times are ISO in UTC. A reminder never changes the item. Answering the item (confirm, claim, done)
 * or the reminder itself closes it for every recipient at once.
 */
export interface Reminder {
  id: string;
  itemId: string;
  /** Local `YYYY-MM-DD` of the occurrence, in the family's zone. */
  occurrenceDate: string;
  /** When the occurrence starts. */
  occurrenceStart: string;
  ask: ReminderAsk;
  recipientIds: string[];
  /** The first attempt. Escalation steps count from here. */
  firstAt: string;
  /** The next attempt, absent when all attempts are used. */
  fireAt?: string;
  intervalMinutes: number;
  maxAttempts: number;
  tier: Tier;
  attempts: number;
  status: 'scheduled' | 'sent' | 'acknowledged' | 'cancelled';
  escalation?: EscalationStep[];
  /** How many escalation steps have run. */
  escalationsDone?: number;
  /** Who got an escalation (they may answer it too). */
  escalatedToIds?: string[];
  lastSentAt?: string;
  /** "Remind me later": no alert until then, then one more. */
  snoozedUntil?: string;
  answeredBy?: string;
  answeredAt?: string;
  /** No answer: it waits for the summary at this time instead (T8.2 shows it). */
  summaryAt?: string;
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
  /** T5.4: who saved it (absent for seeded ones), and when it was last saved or corrected. */
  createdBy?: string;
  updatedAt?: string;
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
  | 'undo'
  /** T4.2: settings changed (settings.ts). No item, no Undo. `note` lists the setting keys. */
  | 'settings'
  /** T5.4: a preference was added, corrected, removed or put back (preferences.ts). `ref` is its id,
   * `note` is `added`, `corrected`, `removed` or `undone`. Undo is `prefUndo`, not `undo`. */
  | 'preference';

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
  /** T5.4: the preference as it was before this change (`null`: it did not exist), for Undo. */
  prefUndo?: { preferenceId: string; before: Preference | null };
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

/**
 * "Why is this on the board?" from chat (T5.2): Homemind's own record of one item, from the asking
 * member's view. `why` is a stored `Why` that names the item, when there is one; it carries its source.
 */
export interface ItemExplanation {
  itemId: string;
  source: ItemSource;
  createdBy: string;
  createdAt?: string;
  /** The newest change after the create, in the member's view (the screen describes it). */
  lastActivityId?: string;
  why?: Why;
}

/** T5.3: one item a screenshot put on the board (proposed), as the chat card shows it. */
export interface ExtractedEntry {
  itemId: string;
  kind: 'event' | 'preparation' | 'request';
  /** The source text the model quoted, in its own language. */
  quote: string;
  confidence: number;
  /** The time is Homemind's suggestion, not from the source. */
  suggestedTime: boolean;
  unsure: boolean;
}

/** T5.3: an extracted entry that was not added: already on the board, or already over. */
export interface SkippedExtraction {
  kind: 'event' | 'preparation' | 'request';
  title: string;
  reason: 'duplicate' | 'past';
  itemId?: string;
}

/** T5.3: a 接龙 sign-up the screenshot shows. Not an item; claiming is T7.4. */
export interface SignUpInfo {
  topic: string;
  deadline?: string;
  taken: Array<{ who: string; item: string }>;
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
  /** Alerts waiting for the end of the recipient's quiet hours (reminders.ts). Absent means none. */
  heldAlerts?: HeldAlert[];
  /** Messages to the backup contact. Simulated in the demo: nothing leaves the machine. */
  backupMessages?: BackupMessage[];
}

export interface HeldAlert {
  recipientId: string;
  alert: HomemindAlert;
  releaseAt: string;
}

/** A message to the backup contact. It holds no reason and no detail, only "please get in touch". */
export interface BackupMessage {
  id: string;
  at: string;
  reminderId: string;
  to: string;
  channel: BackupContact['channel'];
  text: string;
  textZh: string;
  simulated: boolean;
}

/**
 * What goes over `GET /api/homemind/events`, one SSE frame each (`event:` is `event`, `data:` is the
 * JSON `data`). The client imports this type, so it lives here.
 */
export type StreamMessage =
  /** First frame of every connection. The client refreshes its screen on it, which covers anything missed while it was away. */
  | { event: 'hello'; data: { memberId: string; now: string; offsetMs: number; timezone: string; ppma?: PpmaStatus } }
  /** `item` is `null` when the item left this member's view or no longer exists. Already redacted for this member. */
  | { event: 'item.changed'; data: { itemId: string; item: Item | null } }
  /** Something this member should know now: assigned to you, "Who's taking this?", reminders, escalation. */
  | { event: 'alert'; data: HomemindAlert }
  /** A reminder was answered by someone (or no longer applies): close its alerts in every window. */
  | { event: 'alert.closed'; data: { reminderId: string } }
  /** The demo clock jumped. Carries no item, so it goes to everyone. */
  | { event: 'clock'; data: { now: string; offsetMs: number; timezone: string } }
  /** Family or member settings changed (T4.2). Carries nothing, so it goes to everyone; screens re-read. */
  | { event: 'settings.changed'; data: Record<string, never> }
  /** A preference was saved, corrected or removed (T5.4). Carries nothing; screens re-read. */
  | { event: 'preferences.changed'; data: Record<string, never> }
  /** The PPMA connection changed (T6.1). Carries no family data, so it goes to everyone. */
  | { event: 'ppma.status'; data: { status: PpmaStatus } }
  /** The demo was reset: forget everything shown. */
  | { event: 'demo.reset'; data: Record<string, never> };

/**
 * The PPMA connection, as screens show it (T6.1). `off`: not set up (no `PPMA_URL`). `connecting`:
 * starting. `ok`: the stream is open and the last call worked. `offline`: PPMA can't be reached or
 * refused us; Homemind keeps working and queues what it reports.
 */
export type PpmaStatus = 'off' | 'connecting' | 'ok' | 'offline';

/**
 * `assigned` and `open` come from a person's change (alerts.ts). The rest come from reminders.ts:
 * `reminder` to the recipients, `escalation` to the next person, `backup` (to parents: the backup
 * contact was messaged), `batch` (several small updates as one alert).
 */
export type AlertKind = 'assigned' | 'open' | 'reminder' | 'escalation' | 'backup' | 'batch';

/** One line of a batched alert. */
export interface AlertBatchEntry {
  itemId: string;
  /** Absent when the item is sensitive. */
  title?: string;
  titleZh?: string;
  sensitive: boolean;
}

/**
 * A live alert for one member, shown by the client's AlertBanner. It names no other member's
 * failings (neutral wording is the client's job too). For a sensitive item the title is left out, so
 * the banner says only "You have a reminder".
 */
export interface HomemindAlert {
  /**
   * Stable, so a repeat can be ignored: `<itemId>.<version>.<kind>` for a change,
   * `<reminderId>.<step>` for a reminder.
   */
  id: string;
  kind: AlertKind;
  itemId: string;
  /** The item's version when the alert was made, for the banner's own buttons ("I'm on it", "I'll take it"). */
  itemVersion: number;
  tier: Tier;
  at: string;
  /** Who made the change: a member id, or `homemind` for a reminder. */
  byId: string;
  byName: string;
  byNameZh?: string;
  /** Absent when the item is sensitive. */
  title?: string;
  titleZh?: string;
  sensitive: boolean;
  /** Reminder kinds: the reminder, what it asks, and the local start time `HH:MM`. */
  reminderId?: string;
  ask?: ReminderAsk;
  time?: string;
  /** A weekly item can't be marked done as a whole, so its alert offers no Done. */
  recurring?: boolean;
  /** `backup`: who was messaged (a simulated contact in the demo). */
  contactName?: string;
  contactNameZh?: string;
  /** `backup`: the contact is simulated, and the banner says so. */
  simulated?: boolean;
  /** `batch`: the small updates held together. `itemId` is the first one's. */
  entries?: AlertBatchEntry[];
}

/** A reminder that reached a member and is still waiting for an answer, for the reminder buttons on board rows (T4.2). */
export interface PendingReminder {
  itemId: string;
  reminderId: string;
  ask: ReminderAsk;
  /** The member got it as an escalation or a backup notice, not as one of the first recipients. */
  escalated: boolean;
  /** "Remind me later" was tapped and its time has not come yet. */
  snoozed: boolean;
}
