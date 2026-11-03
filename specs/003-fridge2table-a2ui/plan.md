# Plan

```
Browser (React, ChatView + A2uiSurfaceView)
   | POST /api/fridge/chat (multipart), GET steps/inventory/photo, POST made/bought/undo
DigitalMate bridge (server/fridge.ts, in vite dev/preview and services/bridge)
   | builds A2UI JSONL with src/lib/fridgeSurfaces.ts, keeps the household cookie
Fridge2Table (FastAPI, FRIDGE2TABLE_URL, e.g. https://fridge-to-table.onrender.com)
```

- `src/lib/fridgeSurfaces.ts` - pure builders: chat, recipe, inventory, made, bought, error turns;
  `isKitchenIntent` and `photoLocation` for routing.
- `server/fridge.ts` - bridge handler and Vite plugin, same shape as `server/epic.ts`.
- `src/transport/fridge.ts` - `Fridge2TableTransport` (a `ChatTransport`) and `runFridgeAction` for card buttons.
- `src/components/a2ui/fridgeComponents.tsx` - new catalog component `RecipeOptions`.
- `src/App.tsx` - routes Kitchen-companion and kitchen-intent turns to Fridge2Table; `kind: "fridge"` actions.
- `src/data/personas.ts` - Kitchen companion.
- `scripts/fake-fridge2table.mjs` - contract-following stand-in server (no model).

## Tests
- vitest: surface builders and routing (`tests/fridgeSurfaces.test.ts`); bridge against the fake server
  (`tests/fridgeBridge.test.ts`: cookie, photos, steps, made/undo, bought, photo proxy, errors, path and
  origin checks, pinned household, unreachable upstream).
- Playwright (`e2e/fridge2table.spec.ts`): chat -> meal cards -> steps -> made -> undo; Kitchen companion with
  a photo, Mode B with a swap and "I bought these"; phone width; axe; restaurant search unchanged.
- Contract check against the real Fridge2Table FastAPI app run locally with a seeded household and no model
  key: inventory, stored steps, made, undo, bought, undo, model-down error and unknown recipe all worked.
