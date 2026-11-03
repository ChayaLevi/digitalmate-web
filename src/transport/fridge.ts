import type { A2uiAction, A2uiSurface, Language } from '../types';
import { apiUrl } from '../lib/api';
import { A2uiSurfaceStore } from '../protocol/a2ui/store';
import { fx, photoLocation } from '../lib/fridgeSurfaces';
import type { FridgeTurn } from '../lib/fridgeSurfaces';
import type { ChatTransport, ChatTurnEvent, ChatTurnRequest } from './types';

export interface FridgeHealth {
  configured: boolean;
  reachable: boolean;
  upstream?: string;
  pinnedHousehold?: boolean;
}

export async function fridgeHealth(signal?: AbortSignal): Promise<FridgeHealth> {
  const response = await fetch(apiUrl('/api/fridge/health'), { headers: { accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`Fridge2Table bridge health check failed with HTTP ${response.status}`);
  return (await response.json()) as FridgeHealth;
}

/** The surface inside a bridge turn, parsed through the normal A2UI store. */
export function surfaceOfTurn(turn: FridgeTurn): A2uiSurface | undefined {
  if (!turn.jsonl) return undefined;
  return A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
}

async function readTurn(response: Response): Promise<FridgeTurn> {
  if (!response.ok) {
    let message = `Fridge2Table bridge answered HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  return (await response.json()) as FridgeTurn;
}

function emitTurn(turn: FridgeTurn, onEvent: (event: ChatTurnEvent) => void): void {
  turn.thinking.forEach((step, index) => {
    onEvent({ type: 'thinking', step, steps: turn.thinking, index, total: turn.thinking.length });
  });
  if (turn.message) onEvent({ type: 'text', text: turn.message });
  const surface = surfaceOfTurn(turn);
  if (surface) onEvent({ type: 'surface', surface });
  if (turn.followUps.length) onEvent({ type: 'followUps', followUps: turn.followUps });
}

/**
 * Chat turns for the Kitchen companion: sent to Fridge2Table through the DigitalMate bridge
 * (server/fridge.ts), which answers with the agent's reply, its trace and an A2UI surface.
 */
export class Fridge2TableTransport implements ChatTransport {
  readonly id = 'fridge2table' as const;

  constructor(private readonly sessionId: string) {}

  async send(request: ChatTurnRequest, onEvent: (event: ChatTurnEvent) => void, signal: AbortSignal): Promise<void> {
    const lang: Language = request.lang;
    const working = fx(lang, 'working');
    onEvent({ type: 'thinking', step: working, steps: [working], index: 0, total: 1 });

    const form = new FormData();
    form.append('session_id', this.sessionId);
    form.append('message', request.text);
    form.append('cook_mode', request.cookMode ?? 'home');
    const place = photoLocation(request.text);
    for (const image of (request.images ?? []).slice(0, 4)) {
      form.append('images', image, image.name);
      form.append('locations', place);
    }
    const response = await fetch(apiUrl(`/api/fridge/chat?lang=${lang}`), {
      method: 'POST',
      body: form,
      headers: { 'x-fridge-message': encodeURIComponent(request.text.slice(0, 500)) },
      signal
    });
    const turn = await readTurn(response);
    if (signal.aborted) return;
    emitTurn(turn, onEvent);
    onEvent({ type: 'done' });
  }
}

/**
 * Card buttons on Fridge2Table surfaces (kind "fridge"). Returns the bridge turn to show as a new
 * assistant message, or null when the action is handled by sending a new chat turn instead.
 */
export async function runFridgeAction(action: A2uiAction, lang: Language): Promise<FridgeTurn | null> {
  const args = action.args ?? {};
  const post = (path: string, body: unknown) =>
    fetch(apiUrl(`${path}?lang=${lang}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  const [name] = action.id.split(':');
  switch (name) {
    case 'fridge.steps': {
      const recipeId = encodeURIComponent(String(args.recipeId ?? ''));
      const subs = (Array.isArray(args.sub) ? args.sub : []).map(value => `&sub=${encodeURIComponent(String(value))}`).join('');
      return readTurn(await fetch(apiUrl(`/api/fridge/recipe/${recipeId}/steps?lang=${lang}${subs}`)));
    }
    case 'fridge.made':
      return readTurn(await post(`/api/fridge/recipe/${encodeURIComponent(String(args.recipeId ?? ''))}/made`, { substitutions: args.substitutions ?? [] }));
    case 'fridge.bought':
      return readTurn(await post('/api/fridge/inventory/bought', { items: args.items ?? [] }));
    case 'fridge.undo':
      return readTurn(await post('/api/fridge/inventory/undo', { tokens: args.tokens ?? [] }));
    case 'fridge.inventory':
      return readTurn(await fetch(apiUrl(`/api/fridge/inventory?lang=${lang}`)));
    default:
      return null;
  }
}
