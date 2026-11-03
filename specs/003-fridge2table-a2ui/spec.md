# Spec: Fridge2Table inside DigitalMate (web)

Branch: `feat/fridge2table`, built on `epic-replay`. Scope: web only.

## Goal
DigitalMate Web becomes a frontend for the existing Fridge2Table server
(https://github.com/agents-demo/fridge2table). A kitchen question asked in the DigitalMate chat goes
to the Fridge2Table agent, and its answer comes back as A2UI surfaces: meal cards, swaps, a shopping
list, the kitchen inventory, recipe steps, "I made it", "I bought these" and undo.

## User stories
1. In the normal chat, "What can I cook tonight?" (or any fridge / pantry / recipe question) is answered
   by Fridge2Table. "Find a restaurant for dinner" still uses the existing nearby-food scenario.
2. The Kitchen companion sends every message to Fridge2Table, which itself answers off-topic messages
   with a fixed reply.
3. Photos attached in the composer are sent with the turn; each photo is tagged fridge, freezer or pantry
   from the user's words (default fridge).
4. The agent's tool trace is shown as the thinking steps; its clarifying questions become follow-ups.
5. Each meal card shows the dish photo, time, servings and what it uses, with "Show steps" and "I made it".
6. "I made it" and "I bought these" update the inventory and offer Undo.
7. "Shopping is OK" re-asks the same question in shop mode when Fridge2Table offers it.
8. "Show my kitchen" shows fridge, freezer and pantry, with use-soon and low items marked.

## Requirements
- FR-1 The browser talks only to DigitalMate (`/api/fridge/*`). Fridge2Table has no CORS and is never
  called from the browser.
- FR-2 Every card is an A2UI v0.9.1 surface (createSurface / updateComponents / updateDataModel) built by
  the bridge from Fridge2Table's HTTP API (`src/lib/fridgeSurfaces.ts`, pure functions).
- FR-3 Photos and dish images go over plain HTTP through the bridge. A2UI describes screens only.
- FR-4 No secrets or upstream cookies reach browser code. Fridge2Table's `household` id is kept in the
  bridge's own httponly cookie (path `/api/fridge`); `FRIDGE2TABLE_HOUSEHOLD` can pin one household.
- FR-5 Only whitelisted paths are forwarded: health, chat, opening, inventory, bought, undo, recipe steps,
  made and photo. Recipe ids and undo tokens are validated. Cross-origin POSTs are rejected. Admin routes
  (`/admin/*`) are never exposed.
- FR-6 Upstream errors and an unreachable server show an ErrorNotice surface, not a broken chat.
- FR-7 English and Chinese strings. Phone width without horizontal overflow.
- FR-8 Without `FRIDGE2TABLE_URL`, DigitalMate behaves exactly as before.

## Out of scope
Changing the fridge2table repository, Android, the inventory side-panel edits (PATCH /inventory),
delivery notices, auth in front of Fridge2Table.

## Known limits
- One request per turn (11-15 s on the real agent); there is no upstream progress stream, so the chat
  shows one "Asking Fridge2Table" step until the trace arrives.
- The checklist ticks are local; "I bought these" marks every "To buy" item as bought.
- A photo's place comes from the message text, not from a per-photo picker.
