#!/usr/bin/env node
/**
 * A stand-in for the Fridge2Table server (https://github.com/agents-demo/fridge2table) that follows
 * its HTTP API (app/api.py) and response models (app/models.py): POST /chat, GET /opening,
 * GET /inventory, POST /inventory/bought, POST /inventory/undo/{token}, GET /recipe/{id}/steps,
 * POST /recipe/{id}/made, GET /recipe/{id}/photo, GET /health. It runs no model: the replies are
 * canned, the inventory is in memory, one per `household` cookie like the real server.
 * Use it to try the DigitalMate flow without DeepSeek keys or Render.
 *
 *   node scripts/fake-fridge2table.mjs        # listens on 127.0.0.1:8020
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.FAKE_F2T_PORT ?? 8020);
const delayMs = Number(process.env.FAKE_F2T_DELAY_MS ?? 600);
const photo = readFileSync(fileURLToPath(new URL('../e2e/fixtures/frame.jpg', import.meta.url)));

const SEED = [
  ['spinach', 'Spinach', 'vegetable', 'some', 'fridge', true],
  ['egg', 'Eggs', 'egg', 'plenty', 'fridge', false],
  ['milk', 'Milk', 'dairy', 'some', 'fridge', false],
  ['cheddar', 'Cheddar', 'dairy', 'some', 'fridge', false],
  ['cottage cheese', 'Cottage cheese', 'dairy', 'some', 'fridge', false],
  ['eggplant', 'Eggplant', 'vegetable', 'some', 'fridge', true],
  ['tomato', 'Tomatoes', 'vegetable', 'plenty', 'fridge', false],
  ['frozen pea', 'Frozen peas', 'frozen', 'some', 'freezer', false],
  ['pasta', 'Pasta', 'pasta', 'plenty', 'pantry', false],
  ['rice', 'Rice', 'grain', 'low', 'pantry', false]
];

const RECIPES = {
  a1b2c3: {
    name: 'Spinach and cheddar frittata', time_minutes: 20, servings: 2, requested: false,
    ingredients: [['egg', '5', true, 'egg'], ['spinach', '2 handfuls', true, 'vegetable'], ['cheddar', '60 g', true, 'dairy'], ['milk', '50 ml', false, 'dairy']],
    steps: ['Heat the oven grill.', 'Wilt the spinach in a pan with a little oil.', 'Whisk the eggs with the milk, add the cheddar.', 'Pour over the spinach, cook 5 minutes, then grill until set.']
  },
  d4e5f6: {
    name: 'Roasted eggplant and tomato pasta', time_minutes: 30, servings: 4, requested: false,
    ingredients: [['pasta', '300 g', true, 'pasta'], ['eggplant', '1', true, 'vegetable'], ['tomato', '4', true, 'vegetable'], ['olive oil', '2 tbsp', true, 'condiment']],
    steps: ['Roast the diced eggplant at 220 °C for 20 minutes.', 'Cook the pasta.', 'Soften the chopped tomatoes in olive oil.', 'Toss everything together.']
  },
  a7b8c9: {
    name: 'Pea and egg fried rice', time_minutes: 15, servings: 2, requested: false,
    ingredients: [['rice', '2 cups cooked', true, 'grain'], ['frozen pea', '1 cup', true, 'frozen'], ['egg', '2', true, 'egg'], ['soy sauce', '2 tbsp', true, 'sauce']],
    steps: ['Scramble the eggs and set aside.', 'Fry the rice with the peas.', 'Add soy sauce and the eggs.']
  },
  f0e1d2: {
    name: 'Lasagna', time_minutes: 75, servings: 6, requested: true,
    ingredients: [['lasagna sheet', '12', true, 'pasta'], ['ricotta', '250 g', true, 'dairy'], ['tomato', '6', true, 'vegetable'], ['cheddar', '100 g', true, 'dairy'], ['spinach', '2 handfuls', false, 'vegetable']],
    steps: ['Make a tomato sauce.', 'Layer sheets, sauce, cheese and spinach.', 'Bake 45 minutes at 190 °C.']
  }
};

const households = new Map();

function now() {
  return new Date().toISOString();
}

function household(req, res) {
  const match = /(?:^|;\s*)household=([0-9a-f]{32})/.exec(req.headers.cookie ?? '');
  let id = match?.[1];
  if (!id) {
    id = randomUUID().replace(/-/g, '');
    res.setHeader('set-cookie', `household=${id}; HttpOnly; Max-Age=315360000; Path=/; SameSite=lax`);
  }
  if (!households.has(id)) {
    households.set(id, {
      items: SEED.map(([name, display, category, qty, location, soon]) => ({
        id: randomBytes(4).toString('hex'), name, display_name: display, category, qty_level: qty, location,
        confidence: 1, uncertain: false, use_soon: soon, not_seen: false, is_staple: false, source: 'chat',
        updated_at: now(), amount: null, unit: null, amount_text: ''
      })),
      undo: new Map()
    });
  }
  return households.get(id);
}

function state(h) {
  return { inventory: h.items, scan_state: { scanned: { fridge: now(), pantry: now() }, freezer_declined: false } };
}

function recipe(id) {
  const r = RECIPES[id];
  if (!r) return null;
  const ingredients = r.ingredients.map(([name, amount, essential, category]) => ({ name, amount, essential, category }));
  return { id, name: r.name, ingredients, steps: [], time_minutes: r.time_minutes, servings: r.servings, uses_from_inventory: ingredients.filter(i => i.essential).map(i => i.name).filter(n => !['ricotta', 'lasagna sheet', 'olive oil', 'soy sauce'].includes(n)), requested: r.requested, photo_query: '' };
}

function trace(items) {
  return items.map(([tool, args, result, label, failed = false]) => ({ tool, args_summary: args, result_summary: result, failed, seconds: 1.2, label }));
}

function chatReply(message, cookMode) {
  const text = message.toLowerCase();
  if (/weather|football|stock/.test(text)) {
    return { reply: { message: "I can only help with your kitchen: what to cook, what's in your fridge and what to buy.", off_topic: true }, trace: [] };
  }
  if (/lasagna/.test(text)) {
    return {
      reply: {
        message: 'For lasagna you have the tomatoes and cheddar. You need lasagna sheets and ricotta, and cottage cheese works instead of ricotta.',
        meal_ids: ['f0e1d2'], meals: [recipe('f0e1d2')],
        substitutions: [{ missing: 'ricotta', use_instead: 'cottage cheese' }],
        shopping_list: ['lasagna sheet'], check_first: [], questions: ['Do you want a lighter version with spinach?']
      },
      trace: trace([['get_inventory', '', '10 items', 'read your kitchen'], ['get_recipe', 'Lasagna', 'missing 2', 'found the recipe: 2 missing'], ['output check', '', 'ok', 'checked by code']])
    };
  }
  const quick = /quick|fast|20 min|minutes/.test(text);
  const ids = quick ? ['a1b2c3', 'a7b8c9'] : ['a1b2c3', 'd4e5f6', 'a7b8c9'];
  const shop = cookMode === 'shop';
  return {
    reply: {
      message: quick
        ? 'Two quick ones from what you have. The frittata uses up the spinach before it wilts.'
        : 'Three ideas from your kitchen. The frittata and the pasta use up the spinach and the eggplant first.',
      meal_ids: ids, meals: ids.map(recipe),
      substitutions: [],
      shopping_list: shop ? ['parmesan'] : [],
      check_first: ['soy sauce', 'olive oil'],
      questions: [], offer_shop: !shop && quick
    },
    trace: trace([
      ['get_inventory', '', '10 items', 'read your kitchen'],
      ['suggest_meals', quick ? "'quick' max 20 min" : '', '4 candidates: 3 passed, 1 failed', `${ids.length + 1} ideas, 1 failed check (no cream)`, true],
      ['output check', '', 'ok', 'checked by code']
    ])
  };
}

function field(body, name) {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  return match ? match[1] : '';
}

async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1');
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (path === '/health') return send(res, 200, { ok: true });
    const h = household(req, res);

    if (path === '/chat' && req.method === 'POST') {
      const body = await read(req);
      const message = Buffer.from(field(body, 'message'), 'latin1').toString('utf8');
      const images = (body.match(/name="images"; filename=/g) ?? []).length;
      const locations = (body.match(/name="locations"/g) ?? []).length;
      if (images !== locations) return send(res, 400, { detail: `Send one location per image: got ${images} image(s) and ${locations} location(s).` });
      if (!message.trim() && !images) return send(res, 400, { detail: 'Send a message or at least one photo.' });
      if (!field(body, 'session_id')) return send(res, 422, { detail: 'session_id is required' });
      await wait(delayMs);
      let out = chatReply(message, field(body, 'cook_mode'));
      if (images) {
        h.items.push({ ...h.items[0], id: randomBytes(4).toString('hex'), name: 'bell pepper', display_name: 'Bell pepper', category: 'vegetable', qty_level: 'some', use_soon: false, uncertain: true, source: 'photo' });
        out = {
          reply: { ...out.reply, message: `I looked at your ${images} photo(s) and updated the fridge: added a bell pepper (not sure, please check). ${out.reply.message}`, questions: ['Is the red thing on the middle shelf a bell pepper?'] },
          trace: [{ tool: 'recognize', args_summary: `${images} photo(s)`, result_summary: 'added 1, 1 uncertain', failed: false, seconds: 3.1, label: `looked at ${images} photo(s): added 1` }, ...out.trace]
        };
      }
      const steps = out.trace.length;
      return send(res, 200, { ...out, usage: null, ...state(h), trace_summary: steps ? `${steps} steps · ${out.trace.map(t => t.label).join(' → ')}` : '' });
    }
    if (path === '/opening') {
      return send(res, 200, { reply: { message: 'Hi! Your spinach needs using today. A frittata would do it.', meal_ids: ['a1b2c3'], meals: [recipe('a1b2c3')] }, trace: trace([['suggest_meals', 'use soon', '1 passed', '1 idea for the spinach']]), ...state(h) });
    }
    if (path === '/inventory' && req.method === 'GET') return send(res, 200, state(h));
    if (path === '/inventory/bought' && req.method === 'POST') {
      const items = JSON.parse(await read(req));
      const undo = {};
      for (const item of items) {
        const token = randomUUID().replace(/-/g, '');
        undo[item.name] = token;
        h.undo.set(token, { remove: item.name });
        h.items.push({ ...h.items[0], id: randomBytes(4).toString('hex'), name: item.name, display_name: item.name, category: item.category ?? 'other', qty_level: 'plenty', location: 'pantry', use_soon: false, source: 'manual' });
      }
      return send(res, 200, { ...state(h), sizes: {}, previous: {}, undo });
    }
    const undo = /^\/inventory\/undo\/([0-9a-f]{32})$/.exec(path);
    if (undo && req.method === 'POST') {
      const entry = h.undo.get(undo[1]);
      if (!entry) return send(res, 404, { detail: 'Nothing to undo (unknown or already used)' });
      h.undo.delete(undo[1]);
      if (entry.remove) h.items = h.items.filter(item => item.name !== entry.remove);
      if (entry.restore) h.items = entry.restore;
      return send(res, 200, state(h));
    }
    const rec = /^\/recipe\/([^/]+)\/(steps|made|photo)$/.exec(path);
    if (rec) {
      const r = recipe(rec[1]);
      if (!r) return send(res, 404, { detail: `Unknown recipe id '${rec[1]}'.` });
      if (rec[2] === 'photo') {
        res.setHeader('content-type', 'image/jpeg');
        return res.end(photo);
      }
      if (rec[2] === 'steps') {
        await wait(delayMs);
        return send(res, 200, { ...r, steps: RECIPES[rec[1]].steps });
      }
      if (rec[2] === 'made' && req.method === 'POST') {
        const token = randomUUID().replace(/-/g, '');
        h.undo.set(token, { restore: structuredClone(h.items) });
        const changes = [];
        for (const ingredient of r.ingredients.filter(i => i.essential)) {
          const item = h.items.find(x => x.name === ingredient.name);
          if (!item) continue;
          const before = item.qty_level;
          const after = before === 'plenty' ? 'some' : before === 'some' ? 'low' : 'removed';
          if (after === 'removed') h.items = h.items.filter(x => x !== item);
          else item.qty_level = after;
          changes.push({ name: item.name, display_name: item.display_name, before, after });
        }
        const summary = changes.map(c => (c.after === 'removed' ? `${c.display_name} removed` : `${c.display_name} ${c.before} → ${c.after}`)).join(', ') || 'nothing to deduct';
        return send(res, 200, { ...state(h), changes, summary, token });
      }
    }
    send(res, 404, { detail: 'Not Found' });
  } catch (error) {
    send(res, 500, { detail: error instanceof Error ? error.message : 'fake server error' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Fake Fridge2Table on http://127.0.0.1:${port} (no model, canned replies)`);
});
