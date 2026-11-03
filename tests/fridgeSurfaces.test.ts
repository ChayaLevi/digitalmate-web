import { describe, expect, it } from 'vitest';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import {
  boughtTurn,
  chatTurn,
  inventoryTurn,
  isKitchenIntent,
  madeTurn,
  photoLocation,
  recipeTurn
} from '../src/lib/fridgeSurfaces';
import type { FridgeChatResponse, FridgeInventoryState, FridgeRecipe } from '../src/lib/fridgeSurfaces';

const inventory: FridgeInventoryState = {
  inventory: [
    { id: '1', name: 'spinach', display_name: 'Spinach', category: 'vegetable', qty_level: 'some', location: 'fridge', use_soon: true },
    { id: '2', name: 'egg', display_name: 'Eggs', category: 'egg', qty_level: 'plenty', location: 'fridge', amount_text: '12 pcs' },
    { id: '3', name: 'salt', display_name: 'Salt', category: 'spice', qty_level: 'plenty', location: 'pantry', is_staple: true }
  ],
  scan_state: { scanned: { fridge: '2026-11-03T10:00:00' } }
};

const frittata: FridgeRecipe = {
  id: 'a1b2c3',
  name: 'Spinach frittata',
  ingredients: [
    { name: 'egg', amount: '5', essential: true, category: 'egg' },
    { name: 'spinach', amount: '2 handfuls', essential: true, category: 'vegetable' },
    { name: 'ricotta', amount: '100 g', essential: false, category: 'dairy' }
  ],
  steps: [],
  time_minutes: 20,
  servings: 2,
  uses_from_inventory: ['egg', 'spinach']
};

function parse(jsonl: string) {
  const surfaces = A2uiSurfaceStore.fromJsonl(jsonl).list();
  expect(surfaces).toHaveLength(1);
  return surfaces[0];
}

describe('chatTurn', () => {
  const response: FridgeChatResponse = {
    ...inventory,
    reply: {
      message: 'Two ideas from your kitchen.',
      meals: [frittata],
      substitutions: [{ missing: 'ricotta', use_instead: 'cottage cheese' }],
      shopping_list: ['parmesan', 'Parmesan'],
      check_first: ['olive oil'],
      not_enough: [{ name: 'parmesan', have: '20 g', need: '50 g' }],
      questions: ['Is that a pepper?'],
      offer_shop: true
    },
    trace: [
      { tool: 'get_inventory', label: 'read your kitchen' },
      { tool: 'suggest_meals', args_summary: "'quick'", label: '' }
    ],
    trace_summary: '2 steps · read your kitchen → suggest_meals'
  };

  it('keeps the reply text, the trace as thinking steps and the questions as follow-ups', () => {
    const turn = chatTurn(response, 'en', { lastMessage: 'something quick' });
    expect(turn.message).toBe('Two ideas from your kitchen.');
    expect(turn.thinking).toEqual(['read your kitchen', "suggest_meals · 'quick'"]);
    expect(turn.followUps).toEqual(['Is that a pepper?']);
  });

  it('builds a valid A2UI surface with meal cards, swaps, shopping list and kitchen counts', () => {
    const surface = parse(chatTurn(response, 'en', { lastMessage: 'something quick' }).jsonl);
    expect(surface.components.meals.component).toBe('RecipeOptions');
    const meals = surface.data.meals as Array<Record<string, unknown>>;
    expect(meals[0].photo).toBe('/api/fridge/recipe/a1b2c3/photo');
    expect(meals[0].uses).toBe('egg, spinach');
    const actions = meals[0].actions as Array<{ id: string; kind: string }>;
    expect(actions.map(action => action.id)).toEqual(['fridge.steps:a1b2c3', 'fridge.made:a1b2c3']);
    expect(actions.every(action => action.kind === 'fridge')).toBe(true);

    const shopping = surface.data.shopping as Array<Record<string, string>>;
    expect(shopping.map(item => item.label)).toEqual(['parmesan', 'olive oil']); // de-duplicated
    expect(shopping[0].meta).toBe('20 g / 50 g');
    expect(surface.data.substitutions).toEqual([{ label: 'ricotta', value: 'use cottage cheese', tone: 'success' }]);

    const bar = surface.components.actions.actions ?? [];
    expect(bar.map(action => action.id)).toEqual(['fridge.bought', 'fridge.shop', 'fridge.inventory']);
    expect(bar[1].args).toEqual({ message: 'something quick' });
    const kitchen = surface.data.kitchen as Array<Record<string, string>>;
    expect(kitchen.find(metric => metric.label === 'Fridge')?.value).toBe('2'); // staples are not counted
  });

  it('returns text only for an off-topic or plain reply', () => {
    const turn = chatTurn({ ...inventory, reply: { message: 'Kitchen only, sorry.', off_topic: true }, trace: [] }, 'en');
    expect(turn.jsonl).toBe('');
    expect(turn.thinking).toEqual([]);
  });

  it('speaks Chinese when asked', () => {
    const surface = parse(chatTurn(response, 'zh').jsonl);
    expect(surface.components.meals.title).toBe('可以做的菜');
  });
});

describe('recipe, inventory, made and bought turns', () => {
  it('shows ingredients with swaps and numbered steps', () => {
    const surface = parse(
      recipeTurn({ ...frittata, steps: ['Whisk.', 'Bake.'] }, 'en', [{ missing: 'ricotta', use_instead: 'cottage cheese' }]).jsonl
    );
    expect(String(surface.components.method.text)).toContain('1. Whisk.\n2. Bake.');
    const rows = surface.data.ingredients as Array<Record<string, string>>;
    expect(rows[2]).toMatchObject({ label: 'cottage cheese (instead of ricotta)', value: '100 g · optional' });
  });

  it('groups the kitchen by place and skips staples', () => {
    const surface = parse(inventoryTurn(inventory, 'en').jsonl);
    expect(surface.data.fridge).toEqual([
      { label: 'Spinach', value: 'some · Use soon', tone: 'warning' },
      { label: 'Eggs', value: '12 pcs', tone: 'muted' }
    ]);
    expect(surface.data.pantry).toEqual([{ label: 'Nothing here yet', value: 'not scanned yet', tone: 'muted' }]);
    expect(surface.components.actions).toBeUndefined();
  });

  it('offers undo after "I made it" and "I bought these"', () => {
    const made = madeTurn({ ...inventory, changes: [], summary: 'egg plenty → some', token: 'a'.repeat(32) }, 'en');
    expect(made.message).toBe('Taken out of your kitchen: egg plenty → some');
    expect(parse(made.jsonl).components.actions.actions?.[0].args).toEqual({ tokens: ['a'.repeat(32)] });
    const bought = boughtTurn({ ...inventory, undo: { parmesan: 'b'.repeat(32) } }, ['parmesan'], 'en');
    expect(bought.message).toBe('Added to your kitchen: parmesan');
    expect(parse(bought.jsonl).components.actions.actions?.[0].args).toEqual({ tokens: ['b'.repeat(32)] });
  });
});

describe('routing helpers', () => {
  it('sends kitchen questions to Fridge2Table but leaves restaurant searches alone', () => {
    expect(isKitchenIntent('What can I cook tonight?')).toBe(true);
    expect(isKitchenIntent('what is in my fridge')).toBe(true);
    expect(isKitchenIntent('今晚冰箱里的东西能做什么')).toBe(true);
    expect(isKitchenIntent('Find a restaurant for dinner nearby')).toBe(false);
    expect(isKitchenIntent('Find coffee nearby')).toBe(false);
  });

  it('tags photos with the place the user names', () => {
    expect(photoLocation('this is my pantry shelf')).toBe('pantry');
    expect(photoLocation('freezer drawer')).toBe('freezer');
    expect(photoLocation('here you go')).toBe('fridge');
  });
});
