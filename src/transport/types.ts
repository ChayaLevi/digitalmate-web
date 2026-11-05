import type { A2uiSurface, Language } from '../types';

export interface ChatTurnRequest {
  text: string;
  lang: Language;
  roomId?: string;
  submissionId: string;
  persona?: string;
  model?: string;
  capabilities?: string[];
  deepSearch?: boolean;
  /** Photos sent with the turn (Fridge2Table only; other transports ignore them). */
  images?: File[];
  /** Fridge2Table: "home" = only what is there, "shop" = a few items to buy are OK. */
  cookMode?: 'home' | 'shop';
}

export type ChatTurnEvent =
  | { type: 'thinking'; step: string; steps: string[]; index: number; total: number }
  | { type: 'text'; text: string }
  | { type: 'surface'; surface: A2uiSurface }
  | { type: 'followUps'; followUps: string[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ChatTransport {
  readonly id: 'mock' | 'orbit' | 'fridge2table' | 'homemind';
  send(
    request: ChatTurnRequest,
    onEvent: (event: ChatTurnEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
}
