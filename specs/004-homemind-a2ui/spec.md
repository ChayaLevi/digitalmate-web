# Spec: Homemind inside DigitalMate (web)

Branch: `feat/homemind`, built on `feat/fridge2table`. Scope: web only.

The full plan (architecture, designs, tasks) is in [`docs/PLAN.md`](../../docs/PLAN.md). Rules for the build are
in [`CLAUDE.md`](../../CLAUDE.md), and the current state is in [`docs/PROGRESS.md`](../../docs/PROGRESS.md). This
file is the short summary the team convention asks for. When the two differ, `docs/PLAN.md` wins.

## Goal
Homemind is a family app in a new Family tab of DigitalMate Web. Each member has a personal view of one
shared family board. It collects what is happening at home, decides who needs to know what and when, and
acts under rules the family set. The differentiator is coordination between people: ownership, "Who's
taking this?", escalation, and checking members' availability against each other.

## User stories
The five demo scenes in `docs/PLAN.md` section 1 are the stories:
1. Assignment and escalation: Mom assigns pickup to Dad, he sees it live, no answer escalates to Mom.
2. Kindergarten group: a Chinese 接龙 sign-up in a simulated group is claimed and then corrected using a saved preference.
3. A day gone wrong: "Noa is sick" shows what falls through and proposes who stays home.
4. Wedding, pizza, babysitter: an availability conflict, a prepared order that needs one tap, "Why?".
5. Judgment and correction: a message waits for the evening summary, and a memory correction changes the next suggestion.

## Requirements
- FR-1 The browser talks only to the bridge (`/api/homemind/*`). Model and PPMA keys stay in bridge env vars.
- FR-2 Screens and cards are A2UI surfaces built by `src/lib/homemindSurfaces.ts` from the core's domain data.
- FR-3 The core (`server/homemind/`) is pure and is the source of truth for the board. PPMA is memory and advice.
- FR-4 "Parents only" is enforced on the server before any surface, event, search result or model context.
- FR-5 Buying, ordering, paying or sending outside the family needs a parent's tap on a card for that action.
- FR-6 Everything simulated is labeled on the card. Failures show an `ErrorNotice` or an empty state.
- FR-7 Every UI string is in English and Simplified Chinese. Screens work at 390 px and pass axe.
- FR-8 Without `HOMEMIND_ENABLED=1`, DigitalMate behaves exactly as before.

## Out of scope
See `docs/PLAN.md` section 6: native HarmonyOS, real orders or payments, real WeChat or email access,
production auth, Fridge2Table sync.
