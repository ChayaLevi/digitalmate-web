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
  /** T7.5: the messages this item was made from, each at the version it was read. */
  sourceRefs?: SourceRef[];
  /** T7.5: a message it was made from changed since; reminders wait until a parent applies, keeps or discards. */
  stale?: StaleMark;
}

/** T7.5: a message (group or inbox) at one version. */
export interface SourceRef {
  id: string;
  version: number;
}

/**
 * T7.5: why an item no longer matches the message it came from. Values are plain data (ISO times or a
 * sign-up choice's key); screens word them. The reason is Homemind's own words, in both languages.
 */
export interface StaleMark {
  changeId: string;
  at: string;
  field: 'start' | 'choice' | 'unclear';
  oldValue?: string;
  newValue?: string;
  reason: string;
  reasonZh: string;
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

/**
 * A prepared action (an order, a message out, a sign-up claim) that waits for a parent's tap
 * (actions.ts). `mode` comes from the adapter, never from whoever prepared the card.
 * `executing`: the adapter is running; the card can't run a second time meanwhile.
 */
export interface ActionCard {
  id: string;
  adapter: string;
  mode: 'real' | 'simulated';
  payload: Record<string, unknown>;
  /** sha256 of the canonical JSON of `payload` when the card was prepared. */
  payloadHash: string;
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'expired' | 'cancelled';
  expiresAt: string;
  whyId: string;
  /** T7.1: the autonomy area (from the adapter), what screens call it, and where it came from. */
  area?: string;
  title?: string;
  titleZh?: string;
  createdAt?: string;
  ruleId?: string;
  /** T7.1: ids of confirmation tokens already spent on this card (single use). */
  usedTokenIds?: string[];
  /** T7.1: who ran it (a member id, or `homemind` for autonomy level 4), when it ended, and how. */
  executedBy?: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
  /** T7.3: board items the card's text is about (the wedding that makes Mom away). A member who can't
   * see one of them does not get the card (visibility.ts), as for a `Why`. */
  refs?: string[];
  /** T7.5: the messages the card quotes, at the version it was prepared from. */
  sourceRefs?: SourceRef[];
  /** T7.5: a message it quotes changed. A held card never runs (not even at level 4) until a parent decides. */
  held?: { changeId: string; at: string; reason: string; reasonZh: string };
}

/**
 * T7.3: one time a standing rule looked at its next occurrence (rules.ts). `prepared` made a card;
 * `stopped` made none and says why, so a rule that did nothing is visible too. Text is built by screens.
 */
export interface RuleRun {
  id: string;
  ruleId: string;
  /** Local `YYYY-MM-DD` of the occurrence, and its instant (the pizza's delivery time). */
  date: string;
  occurrence: string;
  at: string;
  /** What started it: the rule's own lead time, a calendar change, or the demo control. */
  trigger: 'schedule' | 'calendar' | 'demo';
  outcome: 'prepared' | 'stopped';
  reason?: 'over_cap' | 'closed' | 'nobody_home' | 'invalid';
  cardId?: string;
  /** Both parents are out then: a babysitter message was drafted, or no sitter on the list is free. */
  sitter?: 'drafted' | 'none_free';
  sitterCardId?: string;
  /** Who is at home then, and who is away because of which event. */
  home: string[];
  away: Array<{ memberId: string; eventId: string }>;
  total?: number;
  currency?: string;
  maxPrice?: number;
  whyId: string;
  /** What the plan would show, as one string (rules.ts): a new run is recorded only when it changes. */
  planKey?: string;
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
  | 'preference'
  /** T7.1: an action card was executed, failed, cancelled or expired (actions.ts). `ref` is the card id,
   * `note` is that outcome. No Undo: what an adapter did outside cannot be taken back from here. */
  | 'action'
  /** T7.3: a standing rule was created, turned on or off. `ref` is the rule id, `note` is `created`, `enabled` or `disabled`. No Undo.
   * T7.4: also a group's claim setting (`ref` is the group id, `note` `enabled`, `disabled`, `auto` or `ask`). */
  | 'rule'
  /** T7.5: items marked or cleared because a message they came from changed (`ref` is the source change,
   * `note` is `marked`, `applied`, `kept`, `discarded` or `synced`). Undo through the source change. */
  | 'source';

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
  /** T7.3: the summary in Simplified Chinese, when Homemind wrote it itself (a rule). */
  summaryZh?: string;
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
  /** T7.2: the simulated services' own state (fakes.ts). Absent in older files: fakes.ts fills in the seed. */
  services?: ServicesState;
  /** T7.3: what the standing rules did, newest last (rules.ts keeps at most 100). Absent means none. */
  ruleRuns?: RuleRun[];
  /** T7.4: per group, whether Homemind may claim food in its sign-ups. Absent (the seed): off everywhere. */
  groupPolicies?: GroupClaimPolicy[];
  /** T7.4: every sign-up Homemind looked at, claimed or stopped on, newest last. */
  groupClaims?: GroupClaim[];
  /** T7.5: messages that changed after the family's items, claims or cards were made from them, newest last. */
  sourceChanges?: SourceChange[];
}

// --- source changes (T7.5, sourceChanges.ts) -------------------------------------------------------------

/** One difference between what a message said and what it says now, found in code (never by the model). */
export type SourceDiff =
  | { field: 'eventStart' | 'deadline'; old?: string; new?: string }
  | { field: 'options'; removed: string[]; added: string[] }
  /** The family's claimed choice is no longer on the list (or someone else took it). `switchTo` is what Apply would post instead. */
  | { field: 'choice'; old: string; oldLabel: string; switchTo?: string; switchToLabel?: string }
  /** The new version could not be read: Apply is not offered. */
  | { field: 'unclear'; problem: string; problemZh: string };

/**
 * T7.5: a message the family's work depends on got a new version. `pending` until a parent applies the
 * changes, keeps things as they are, or discards what depended on it. Every one of those has Undo, as far
 * as the board goes (a message already posted in the simulated group can't be taken back).
 */
export interface SourceChange {
  id: string;
  groupId: string;
  claimId: string;
  at: string;
  messages: Array<{ id: string; from: number; to: number }>;
  status: 'pending' | 'applied' | 'kept' | 'discarded';
  diffs: SourceDiff[];
  /** Board items that depend on the old version, and cards that quote it (held). */
  itemIds: string[];
  cardIds: string[];
  /** What the event was and would become, for the card's headline. */
  oldEventStart?: string;
  newEventStart?: string;
  whyId: string;
  resolvedBy?: string;
  resolvedAt?: string;
  /** The core activity of the resolution (its Undo patch), and a correction posted or prepared with it. */
  activityId?: string;
  correctionCardId?: string;
  /** The claim as it was before the resolution, for Undo. */
  claimBefore?: GroupClaim;
  undoneAt?: string;
}

/** T7.5: a source change as one member's screen shows it (items limited to what that member can see). */
export interface SourceChangeView {
  change: SourceChange;
  groupName: string;
  groupNameZh: string;
  eventTitle?: string;
  eventTitleZh?: string;
  items: Array<{ id: string; title: string; titleZh?: string; stale?: StaleMark }>;
  /** Whether Undo is possible now (resolved, not undone, and nothing was posted with it). */
  undoable: boolean;
  /** Apply is offered only when the new version could be read. */
  canApply: boolean;
}

// --- group sign-up claims (T7.4, groupClaims.ts) ---------------------------------------------------------

/**
 * What Homemind may do in one group's sign-ups (接龙). **Off by default.** A parent turns it on, which is
 * the first-time approval of exactly these limits: food only, at most `maxCost` per claim, posted as that
 * parent. Whether a claim posts on its own or waits for a tap is the autonomy level of the `group` area.
 */
export interface GroupClaimPolicy {
  groupId: string;
  enabled: boolean;
  /** The parent who turned it on (the approval), and when. Claims are posted as this parent. */
  approvedBy?: string;
  approvedAt?: string;
  /** Estimated cost cap per claim. */
  maxCost: number;
  currency: string;
}

/** Why a sign-up got no claim. `failed`: the simulated group did not take the post. */
export type GroupClaimStop = 'unclear' | 'closed' | 'nothing_suitable' | 'already_signed_up' | 'paused' | 'failed' | 'withdrawn';

/** One choice on a sign-up list, as written in the message. `key` names a food Homemind knows. */
export interface SignUpOption {
  label: string;
  key?: string;
  /** Who already wrote their name next to it. */
  takenBy?: string;
}

/** A correction of a claim ("Change"): from one option key to another. T7.5: `to: ''` takes the family's name off the list. */
export interface GroupClaimChange {
  at: string;
  by: string;
  from: string;
  to: string;
  cardId: string;
  status: 'waiting' | 'posted' | 'failed';
}

/**
 * T7.4: one sign-up message Homemind looked at. `waiting`: the claim card waits for a parent's tap.
 * `claimed`: posted in the group, with the event and preparations on the board. `stopped`: nothing
 * posted, `reason` says why. The sign-up is read by fixed rules (not the model), and kept here so the
 * screen can show what was read.
 */
export interface GroupClaim {
  id: string;
  groupId: string;
  messageId: string;
  /** The message's version when it was read (T7.5 can compare). */
  messageVersion: number;
  /** T7.5: every message the reading used (the sign-up, and the teacher's message the time came from), at its version. */
  sourceRefs?: SourceRef[];
  at: string;
  status: 'waiting' | 'claimed' | 'stopped';
  reason?: GroupClaimStop;
  /** For `unclear`: what could not be read, in plain English and Chinese. */
  problem?: string;
  problemZh?: string;
  topic?: string;
  options?: SignUpOption[];
  eventTitle?: string;
  eventTitleZh?: string;
  eventStart?: string;
  /** The sign-up closes then (from "周三晚上8点前"). */
  deadline?: string;
  children?: number;
  /** The option key claimed (the current one, after a change). */
  choice?: string;
  asMemberId?: string;
  cardId?: string;
  eventId?: string;
  preparationIds?: string[];
  changes?: GroupClaimChange[];
  whyId: string;
}

/** A sign-up choice as screens show it: the words as written, Homemind's English name, its estimate and effort. */
export interface SignUpChoiceView {
  key: string;
  label: string;
  en: string;
  cost: number;
  currency: string;
  /** `make`: someone has to bake or cook it. Homemind never claims those on its own. */
  effort: 'buy' | 'make';
}

/** T7.4: what the group screens show, computed by groupClaims.ts (plain data; the surfaces word it). */
export interface GroupsView {
  policies: Array<{
    groupId: string;
    name: string;
    nameZh: string;
    enabled: boolean;
    approvedBy?: string;
    approvedAt?: string;
    maxCost: number;
    currency: string;
    /** The `group` area's autonomy level: 4 posts a claim on its own, below 4 a parent taps its card. */
    level: AutonomyLevel;
    paused: boolean;
  }>;
  claims: Array<{
    claim: GroupClaim;
    groupName: string;
    groupNameZh: string;
    choice?: SignUpChoiceView;
    /** What a parent may change to now (free, food, under the cap, no hard preference against it), preferred first. */
    alternatives: Array<SignUpChoiceView & { preferences: Array<Pick<Preference, 'id' | 'text' | 'textZh' | 'reason' | 'reasonZh'>> }>;
    /** The claim card's state, while the claim is not posted. */
    cardStatus?: ActionCard['status'];
    /** A change waits for a parent's tap on its card. */
    changeWaiting?: { to: string; label: string };
  }>;
}

// --- simulated services (T7.2, fakes.ts) ---------------------------------------------------------------

/** One message in the simulated kindergarten group. `version` grows when the sender edits it (T7.5). */
export interface GroupMessage {
  id: string;
  version: number;
  at: string;
  author: string;
  authorZh?: string;
  /** `teacher` and `parent` are other people in the group; `family` is a reply this family posted. */
  from: 'teacher' | 'parent' | 'family';
  text: string;
  /** A reply's kind: a sign-up claim, or a correction of an earlier claim. */
  replyKind?: 'claim' | 'correction';
  replyTo?: string;
  /** T7.5: when the sender last edited it, and the earlier versions' text (oldest first). */
  editedAt?: string;
  earlier?: Array<{ version: number; text: string; at: string }>;
  /** Always true: there is no real group behind it. */
  simulated: true;
}

export interface PizzaOrder {
  id: string;
  at: string;
  lines: Array<{ itemId: string; qty: number; price: number }>;
  total: number;
  currency: string;
  deliverAt?: string;
  simulated: true;
}

export interface BabysitterMessage {
  id: string;
  at: string;
  sitterId: string;
  date: string;
  from: string;
  to: string;
  text: string;
  /** The canned answer the simulated sitter gives. */
  reply: 'yes' | 'no';
  simulated: true;
}

/** What the simulated services remember. Reset with the demo. */
export interface ServicesState {
  group: { id: string; messages: GroupMessage[]; /** How many fixture messages were posted. */ posted: number };
  pizzaOrders: PizzaOrder[];
  babysitterMessages: BabysitterMessage[];
}

/** A simulated service's card as a screen shows it. Every one carries `simulated: true`. */
export interface ServicesView {
  group: {
    id: string;
    name: string;
    nameZh: string;
    messages: GroupMessage[];
    /** Fixture messages not posted yet (the demo control). */
    remaining: number;
    /** T7.5: sample edits not made yet (the "update message" demo control). */
    updates?: number;
    simulated: true;
  };
  pizza: {
    name: string;
    nameZh: string;
    open: boolean;
    /** Local `HH:MM`. */
    opensAt: string;
    closesAt: string;
    currency: string;
    menu: Array<{ id: string; name: string; nameZh: string; price: number; serves: number }>;
    lastOrder?: PizzaOrder;
    simulated: true;
  };
  babysitters: {
    /** Local `YYYY-MM-DD` the availability is for (today). */
    date: string;
    sitters: Array<{ id: string; name: string; nameZh: string; rank: number; note: string; noteZh: string; available: boolean; from?: string; to?: string }>;
    simulated: true;
  };
  /** Only the signed-in member's own mailbox. */
  inbox: {
    approvedSenders: Array<{ address: string; name: string; nameZh: string }>;
    messages: Array<{ id: string; at: string; from: string; fromName: string; fromNameZh: string; subject: string; subjectZh: string; body: string; bodyZh: string }>;
    simulated: true;
  };
  weather: {
    days: Array<{ date: string; summary: string; summaryZh: string; low: number; high: number; rainChance: number }>;
    simulated: true;
  };
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
  /** What PPMA remembers, or an explanation from it, arrived or changed (T6.2). Carries nothing; screens re-read. */
  | { event: 'memory.changed'; data: Record<string, never> }
  /** An action card was prepared, executed, failed, cancelled or expired (T7.1). Carries nothing; screens re-read. */
  | { event: 'actions.changed'; data: Record<string, never> }
  /** A simulated service changed: a group message was posted (T7.2). Carries nothing; screens re-read. */
  | { event: 'services.changed'; data: Record<string, never> }
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
 * contact was messaged), `batch` (several small updates as one alert). `group` (T7.4, groupClaims.ts):
 * Homemind claimed or changed a sign-up in a simulated group; a notice to everyone who sees the event.
 */
export type AlertKind = 'assigned' | 'open' | 'reminder' | 'escalation' | 'backup' | 'batch' | 'group' | 'stale';

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
  /** `group` (T7.4): Homemind signed the family up in a simulated group. What it took, and what it was before a change. */
  groupChoice?: string;
  groupChoiceZh?: string;
  groupFrom?: string;
  groupFromZh?: string;
  /** `stale` (T7.5): a message changed; how many of the member's items depend on it, and what changed, in plain words. */
  staleCount?: number;
  staleWhat?: string;
  staleWhatZh?: string;
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

/** One thing PPMA remembers (T6.2), as a screen shows it. Text is PPMA's, shown as plain text and marked as PPMA's. */
export interface PpmaMemoryStatement {
  id: string;
  text: string;
  origin: 'user' | 'app' | 'inferred';
  confidence: number;
  /** PPMA says this one can be corrected or forgotten. */
  editable: boolean;
  view: string;
  /** A correction was sent and PPMA has not dropped the statement yet. */
  correcting?: 'wrong' | 'forget';
}

/** What the "What we know" screen gets from PPMA. `loading` until the first read ends; never invented. */
export interface PpmaMemoryData {
  state: 'loading' | 'ready' | 'error';
  statements: PpmaMemoryStatement[];
  /** A short code for the last problem. With `ready`, the list is the last good read. */
  error?: string;
}

/** PPMA's own explanation of a decision (T6.2), already trimmed. */
export interface PpmaExplanationData {
  state: 'ready' | 'loading' | 'unavailable';
  summary?: string;
  rationale?: string;
  basis?: Array<{ kind: string; ref?: string; note: string }>;
}
