/**
 * Fridge2Table -> A2UI surface builders.
 *
 * Pure functions: they take what the Fridge2Table FastAPI server returns (ChatResponse, Recipe,
 * InventoryState, MadeState, BoughtState) and produce a chat turn for DigitalMate: the reply text,
 * the agent's trace as thinking steps, follow-up prompts and one A2UI v0.9.1 JSONL surface.
 * The bridge (server/fridge.ts) calls these; the browser only parses and renders the JSONL.
 * Nothing here touches the network.
 *
 * Fridge2Table's API is documented in its own repo (app/api.py, app/models.py). Field names
 * below follow those Pydantic models exactly.
 */
import type { A2uiAction, A2uiComponent } from '../types';

export type FridgeLang = 'en' | 'zh';

// --- Fridge2Table response shapes (subset of app/models.py) ---------------------------------------

export type FridgeLocation = 'fridge' | 'freezer' | 'pantry';

export interface FridgeInventoryItem {
  id: string;
  name: string;
  display_name: string;
  category: string;
  qty_level: 'plenty' | 'some' | 'low';
  location: FridgeLocation;
  uncertain?: boolean;
  use_soon?: boolean;
  not_seen?: boolean;
  is_staple?: boolean;
  amount_text?: string;
}

export interface FridgeScanState {
  scanned: Partial<Record<FridgeLocation, string>>;
  freezer_declined?: boolean;
}

export interface FridgeIngredient {
  name: string;
  amount: string;
  essential: boolean;
  category: string;
}

export interface FridgeRecipe {
  id: string;
  name: string;
  ingredients: FridgeIngredient[];
  steps: string[];
  time_minutes: number;
  servings?: number;
  uses_from_inventory?: string[];
  requested?: boolean;
}

export interface FridgeSubstitution {
  missing: string;
  use_instead: string;
}

export interface FridgeShortfall {
  name: string;
  have: string;
  need: string;
}

export interface FridgeAgentReply {
  message: string;
  meal_ids?: string[];
  meals?: FridgeRecipe[];
  substitutions?: FridgeSubstitution[];
  shopping_list?: string[];
  check_first?: string[];
  not_enough?: FridgeShortfall[];
  questions?: string[];
  off_topic?: boolean;
  offer_shop?: boolean;
}

export interface FridgeTraceItem {
  tool: string;
  args_summary?: string;
  result_summary?: string;
  failed?: boolean;
  seconds?: number | null;
  label?: string;
}

export interface FridgeInventoryState {
  inventory: FridgeInventoryItem[];
  scan_state: FridgeScanState;
}

export interface FridgeChatResponse extends FridgeInventoryState {
  reply: FridgeAgentReply;
  trace: FridgeTraceItem[];
  trace_summary?: string;
}

export interface FridgeMadeChange {
  name: string;
  display_name: string;
  before: string;
  after: string;
}

export interface FridgeMadeState extends FridgeInventoryState {
  changes: FridgeMadeChange[];
  summary: string;
  token: string;
}

export interface FridgeBoughtState extends FridgeInventoryState {
  undo: Record<string, string>;
}

/** What the bridge sends the browser for every Fridge2Table interaction. */
export interface FridgeTurn {
  message: string;
  thinking: string[];
  followUps: string[];
  /** One A2UI surface as JSONL; empty when the reply is text only. */
  jsonl: string;
}

// --- strings ----------------------------------------------------------------------------------------

const T = {
  title: { en: 'Fridge2Table', zh: 'Fridge2Table 冰箱到餐桌' },
  meals: { en: 'Meals you can make', zh: '可以做的菜' },
  requested: { en: 'The dish you asked for', zh: '你想做的菜' },
  subs: { en: 'Swaps from your kitchen', zh: '用家里现有的替换' },
  useInstead: { en: 'use', zh: '改用' },
  insteadOf: { en: 'instead of', zh: '代替' },
  shopping: { en: 'Shopping list', zh: '购物清单' },
  toBuy: { en: 'To buy', zh: '需要购买' },
  checkFirst: { en: 'Check your pantry first', zh: '先看看储物柜' },
  bought: { en: 'I bought these', zh: '这些已买到' },
  shopOk: { en: 'Shopping is OK', zh: '可以去买点东西' },
  steps: { en: 'Show steps', zh: '查看步骤' },
  made: { en: 'I made it', zh: '我做好了' },
  ingredients: { en: 'Ingredients', zh: '食材' },
  method: { en: 'Method', zh: '做法' },
  optional: { en: 'optional', zh: '可选' },
  minutes: { en: 'min', zh: '分钟' },
  serves: { en: 'serves', zh: '份量' },
  uses: { en: 'Uses', zh: '用到' },
  asked: { en: 'You asked', zh: '你点的' },
  inventory: { en: 'Your kitchen', zh: '你的厨房' },
  fridge: { en: 'Fridge', zh: '冰箱' },
  freezer: { en: 'Freezer', zh: '冷冻室' },
  pantry: { en: 'Pantry', zh: '储物柜' },
  useSoon: { en: 'Use soon', zh: '尽快吃掉' },
  notScanned: { en: 'not scanned yet', zh: '尚未拍照' },
  empty: { en: 'Nothing here yet', zh: '这里还是空的' },
  undo: { en: 'Undo', zh: '撤销' },
  showKitchen: { en: 'Show my kitchen', zh: '看看我的厨房' },
  updated: { en: 'Inventory updated', zh: '库存已更新' },
  unreachable: {
    en: 'Fridge2Table is not reachable. Check FRIDGE2TABLE_URL and that the server is running. On Render the first request after a pause can take up to a minute.',
    zh: '无法连接 Fridge2Table。请检查 FRIDGE2TABLE_URL 以及服务器是否在运行。Render 上闲置后的第一次请求可能需要一分钟。'
  },
  failed: { en: 'Fridge2Table could not answer', zh: 'Fridge2Table 暂时无法回答' },
  working: { en: 'Asking Fridge2Table', zh: '正在询问 Fridge2Table' }
} as const;

type Key = keyof typeof T;
export const fx = (lang: FridgeLang, key: Key): string => T[key][lang];

// --- helpers ----------------------------------------------------------------------------------------

/** Paths the browser may load through the bridge. */
export type FridgeProxy = (path: string) => string;
export const defaultFridgeProxy: FridgeProxy = path => `/api/fridge/${path.replace(/^\//, '')}`;

export const FRIDGE_SURFACE_PREFIX = 'fridge2table';

let surfaceSeq = 0;
function nextSurfaceId(kind: string): string {
  surfaceSeq += 1;
  return `${FRIDGE_SURFACE_PREFIX}-${kind}-${Date.now().toString(36)}-${surfaceSeq}`;
}

export function jsonl(
  kind: string,
  title: string,
  subtitle: string | undefined,
  components: A2uiComponent[],
  data: Record<string, unknown>,
  status = 'ready'
): string {
  const surfaceId = nextSurfaceId(kind);
  const lines = [
    { version: 'v0.9.1', createSurface: { surfaceId, root: 'root', title, subtitle, status } },
    { version: 'v0.9.1', updateComponents: { surfaceId, components } },
    { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/', value: data } }
  ];
  return lines.map(line => JSON.stringify(line)).join('\n');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Trace items as plain thinking steps ("5 ideas, 1 failed check (no cream)"). */
export function traceSteps(trace: FridgeTraceItem[] = []): string[] {
  return trace.map(item => item.label || [item.tool, item.args_summary].filter(Boolean).join(' · ')).filter(Boolean);
}

function mealCard(recipe: FridgeRecipe, lang: FridgeLang, proxy: FridgeProxy, substitutions: FridgeSubstitution[]): Record<string, unknown> {
  const essentials = recipe.ingredients.filter(ingredient => ingredient.essential).map(ingredient => ingredient.name);
  const uses = recipe.uses_from_inventory?.length ? recipe.uses_from_inventory : essentials;
  const sub = substitutions.map(item => `${item.missing}:${item.use_instead}`);
  return {
    id: recipe.id,
    name: recipe.name,
    time: `${recipe.time_minutes} ${fx(lang, 'minutes')}`,
    servings: recipe.servings ? `${fx(lang, 'serves')} ${recipe.servings}` : '',
    uses: uses.slice(0, 6).join(', '),
    requested: recipe.requested === true,
    photo: proxy(`recipe/${encodeURIComponent(recipe.id)}/photo`),
    actions: [
      { id: `fridge.steps:${recipe.id}`, label: fx(lang, 'steps'), variant: 'secondary', kind: 'fridge', args: { recipeId: recipe.id, sub } },
      { id: `fridge.made:${recipe.id}`, label: fx(lang, 'made'), variant: 'primary', kind: 'fridge', args: { recipeId: recipe.id, substitutions } }
    ] satisfies A2uiAction[]
  };
}

function counts(state: FridgeInventoryState | undefined, lang: FridgeLang): Array<Record<string, string>> {
  if (!state) return [];
  const items = state.inventory.filter(item => !item.is_staple);
  const by = (location: FridgeLocation) => items.filter(item => item.location === location).length;
  const scanned = state.scan_state?.scanned ?? {};
  const metric = (location: FridgeLocation) => ({
    label: fx(lang, location),
    value: scanned[location] || by(location) ? String(by(location)) : '—',
    tone: 'muted'
  });
  const soon = items.filter(item => item.use_soon).length;
  return [metric('fridge'), metric('freezer'), metric('pantry'), { label: fx(lang, 'useSoon'), value: String(soon), tone: soon ? 'warning' : 'muted' }];
}

// --- builders ---------------------------------------------------------------------------------------

/** POST /chat, GET /opening, POST /notices/{id}/open -> one DigitalMate turn. */
export function chatTurn(
  response: FridgeChatResponse,
  lang: FridgeLang,
  options: { proxy?: FridgeProxy; lastMessage?: string } = {}
): FridgeTurn {
  const proxy = options.proxy ?? defaultFridgeProxy;
  const reply = response.reply;
  const meals = reply.meals ?? [];
  const substitutions = reply.substitutions ?? [];
  const shortBy = new Map((reply.not_enough ?? []).map(item => [item.name.toLowerCase(), `${item.have} / ${item.need}`]));
  const shopping = [
    ...unique(reply.shopping_list ?? []).map(name => ({ label: name, note: fx(lang, 'toBuy'), meta: shortBy.get(name.toLowerCase()) ?? '', checked: false })),
    ...unique(reply.check_first ?? []).map(name => ({ label: name, note: fx(lang, 'checkFirst'), meta: shortBy.get(name.toLowerCase()) ?? '', checked: false }))
  ];
  const message = reply.message?.trim() ?? '';
  const thinking = traceSteps(response.trace);
  const followUps = unique(reply.questions ?? []).slice(0, 3);

  const hasCards = meals.length > 0 || shopping.length > 0 || substitutions.length > 0;
  if (!hasCards && !reply.offer_shop) return { message, thinking, followUps, jsonl: '' };

  const requestedOnly = meals.length > 0 && meals.every(meal => meal.requested);
  const children: string[] = [];
  const components: A2uiComponent[] = [];
  if (meals.length) {
    children.push('meals');
    components.push({ id: 'meals', component: 'RecipeOptions', title: fx(lang, requestedOnly ? 'requested' : 'meals'), dataPath: '/meals' });
  }
  if (substitutions.length) {
    children.push('subs');
    components.push({ id: 'subs', component: 'InfoRows', title: fx(lang, 'subs'), dataPath: '/substitutions' });
  }
  if (shopping.length) {
    children.push('shopping');
    components.push({ id: 'shopping', component: 'Checklist', title: fx(lang, 'shopping'), dataPath: '/shopping' });
  }
  const actions: A2uiAction[] = [];
  const buyNames = unique(reply.shopping_list ?? []);
  if (buyNames.length) {
    const categories = new Map(meals.flatMap(meal => meal.ingredients).map(ingredient => [ingredient.name, ingredient.category]));
    actions.push({
      id: 'fridge.bought',
      label: fx(lang, 'bought'),
      variant: 'secondary',
      kind: 'fridge',
      args: { items: buyNames.map(name => ({ name, category: categories.get(name) ?? null })) }
    });
  }
  if (reply.offer_shop && options.lastMessage) {
    actions.push({ id: 'fridge.shop', label: fx(lang, 'shopOk'), variant: 'secondary', kind: 'fridge', args: { message: options.lastMessage } });
  }
  actions.push({ id: 'fridge.inventory', label: fx(lang, 'showKitchen'), variant: 'ghost', kind: 'fridge', args: {} });
  children.push('kitchen', 'actions');
  components.push({ id: 'kitchen', component: 'MetricGrid', title: fx(lang, 'inventory'), dataPath: '/kitchen' });
  components.push({ id: 'actions', component: 'ActionBar', actions });
  components.unshift({ id: 'root', component: 'SurfaceRoot', title: fx(lang, 'title'), children });

  const data = {
    meals: meals.map(meal => mealCard(meal, lang, proxy, substitutions)),
    substitutions: substitutions.map(item => ({ label: item.missing, value: `${fx(lang, 'useInstead')} ${item.use_instead}`, tone: 'success' })),
    shopping,
    kitchen: counts(response, lang)
  };
  return { message, thinking, followUps, jsonl: jsonl('chat', fx(lang, 'title'), response.trace_summary || undefined, components, data) };
}

/** GET /recipe/{id}/steps -> the full recipe as a surface. */
export function recipeTurn(recipe: FridgeRecipe, lang: FridgeLang, substitutions: FridgeSubstitution[] = []): FridgeTurn {
  const subs = new Map(substitutions.map(item => [item.missing.toLowerCase(), item.use_instead]));
  const ingredients = recipe.ingredients.map(ingredient => {
    const swap = subs.get(ingredient.name.toLowerCase());
    return {
      label: swap ? `${swap} (${fx(lang, 'insteadOf')} ${ingredient.name})` : ingredient.name,
      value: [ingredient.amount, ingredient.essential ? '' : fx(lang, 'optional')].filter(Boolean).join(' · '),
      tone: ingredient.essential ? 'muted' : 'accent'
    };
  });
  const method = recipe.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: recipe.name, children: ['ingredients', 'method', 'actions'] },
    { id: 'ingredients', component: 'InfoRows', title: fx(lang, 'ingredients'), dataPath: '/ingredients' },
    { id: 'method', component: 'Text', text: `**${fx(lang, 'method')}**\n\n${method}` },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: [{ id: `fridge.made:${recipe.id}`, label: fx(lang, 'made'), variant: 'primary', kind: 'fridge', args: { recipeId: recipe.id, substitutions } }]
    }
  ];
  const subtitle = [`${recipe.time_minutes} ${fx(lang, 'minutes')}`, recipe.servings ? `${fx(lang, 'serves')} ${recipe.servings}` : '']
    .filter(Boolean)
    .join(' · ');
  return { message: '', thinking: [], followUps: [], jsonl: jsonl('recipe', recipe.name, subtitle, components, { ingredients }) };
}

/** GET /inventory (and the state after made / bought / undo) -> the kitchen as a surface. */
export function inventoryTurn(
  state: FridgeInventoryState,
  lang: FridgeLang,
  options: { message?: string; undoToken?: string; undoTokens?: string[] } = {}
): FridgeTurn {
  const scanned = state.scan_state?.scanned ?? {};
  const places: FridgeLocation[] = ['fridge', 'freezer', 'pantry'];
  const components: A2uiComponent[] = [];
  const children: string[] = ['kitchen'];
  const data: Record<string, unknown> = { kitchen: counts(state, lang) };
  components.push({ id: 'kitchen', component: 'MetricGrid', dataPath: '/kitchen' });
  for (const place of places) {
    const items = state.inventory
      .filter(item => item.location === place && !item.is_staple)
      .sort((a, b) => Number(Boolean(b.use_soon)) - Number(Boolean(a.use_soon)) || a.display_name.localeCompare(b.display_name));
    const rows = items.map(item => ({
      label: item.display_name + (item.uncertain ? ' ?' : ''),
      value: [item.amount_text || item.qty_level, item.use_soon ? fx(lang, 'useSoon') : ''].filter(Boolean).join(' · '),
      tone: item.use_soon ? 'warning' : item.qty_level === 'low' ? 'danger' : 'muted'
    }));
    if (!rows.length) rows.push({ label: fx(lang, 'empty'), value: scanned[place] ? '' : fx(lang, 'notScanned'), tone: 'muted' });
    data[place] = rows;
    children.push(place);
    components.push({ id: place, component: 'InfoRows', title: fx(lang, place), dataPath: `/${place}` });
  }
  const tokens = [options.undoToken, ...(options.undoTokens ?? [])].filter((token): token is string => Boolean(token));
  if (tokens.length) {
    children.push('actions');
    components.push({
      id: 'actions',
      component: 'ActionBar',
      actions: [{ id: 'fridge.undo', label: fx(lang, 'undo'), variant: 'ghost', kind: 'fridge', args: { tokens } }]
    });
  }
  components.unshift({ id: 'root', component: 'SurfaceRoot', title: fx(lang, 'inventory'), children });
  return {
    message: options.message ?? '',
    thinking: [],
    followUps: [],
    jsonl: jsonl('inventory', fx(lang, 'inventory'), options.message ? fx(lang, 'updated') : undefined, components, data)
  };
}

/** POST /recipe/{id}/made -> what changed, with undo. */
export function madeTurn(state: FridgeMadeState, lang: FridgeLang): FridgeTurn {
  const message = lang === 'zh' ? `已从库存中扣除：${state.summary}` : `Taken out of your kitchen: ${state.summary}`;
  return inventoryTurn(state, lang, { message, undoToken: state.token });
}

/** POST /inventory/bought -> the kitchen with the bought items, with undo. */
export function boughtTurn(state: FridgeBoughtState, names: string[], lang: FridgeLang): FridgeTurn {
  const message = lang === 'zh' ? `已加入库存：${names.join('、')}` : `Added to your kitchen: ${names.join(', ')}`;
  return inventoryTurn(state, lang, { message, undoTokens: Object.values(state.undo ?? {}) });
}

export function fridgeErrorTurn(message: string, lang: FridgeLang): FridgeTurn {
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: fx(lang, 'title'), children: ['err'] },
    { id: 'err', component: 'ErrorNotice', title: fx(lang, 'failed'), body: message }
  ];
  return { message: '', thinking: [], followUps: [], jsonl: jsonl('error', fx(lang, 'title'), undefined, components, {}, 'error') };
}

export function fridgeUnreachableTurn(lang: FridgeLang): FridgeTurn {
  return fridgeErrorTurn(fx(lang, 'unreachable'), lang);
}

// --- routing ------------------------------------------------------------------------------------------

/**
 * Kitchen intents that go to Fridge2Table even outside the Kitchen companion. Kept narrow on
 * purpose: "find a restaurant for dinner" stays with the existing food/nearby scenario.
 */
const KITCHEN_INTENT =
  /\b(fridge|freezer|pantry|leftovers?|recipes?|what can i (cook|make)|what should i (cook|make)|cook tonight|cook with|ingredients? (i have|at home)|my kitchen|my inventory|shopping list for)\b|冰箱|冷冻|储物柜|剩菜|菜谱|食谱|做什么菜|能做什么|家里有什么/i;

export function isKitchenIntent(text: string): boolean {
  return KITCHEN_INTENT.test(text);
}

/** Which place a photo shows, from the user's words; Fridge2Table needs one tag per photo. */
export function photoLocation(text: string): FridgeLocation {
  if (/\b(freezer|frozen)\b|冷冻/i.test(text)) return 'freezer';
  if (/\b(pantry|cupboard|shelf|shelves)\b|储物柜|橱柜/i.test(text)) return 'pantry';
  return 'fridge';
}
