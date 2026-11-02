import { describe, expect, it } from 'vitest';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { confirmBody, EPIC_SURFACE_ID, isTerminal, runSurface, startSurface } from '../src/lib/epicSurface';
import type { EpicPlayCard, EpicRunState, EpicStep, EpicStyle } from '../src/lib/epicSurface';

const styles: EpicStyle[] = [
  { id: 'football_commentator', name: 'Football commentator', default: true },
  { id: 'news_reporter', name: 'News reporter' }
];
const proxy = (path: string) => `/api/epic/runs/r1/${path}`;
const step = (n: number, status: EpicStep['status']): EpicStep => ({ n, name: `Step ${n}`, status });

function load(text: string) {
  const store = A2uiSurfaceStore.fromJsonl(text);
  expect(store.getErrors()).toEqual([]);
  const surface = store.get(EPIC_SURFACE_ID);
  expect(surface).toBeDefined();
  return surface!;
}

describe('epic replay A2UI surfaces', () => {
  it('builds a valid start surface with narrators and a default', () => {
    const surface = load(startSurface(styles, 'en'));
    expect(surface.components.style.options).toHaveLength(2);
    expect(surface.components.style.default).toBe('football_commentator');
    expect(surface.components.language.default).toBe('en');
    expect(surface.components.actions.actions?.[0].id).toBe('epic.start');
    expect(surface.data.stage).toBe('start');
  });

  it('localises to Chinese', () => {
    expect(load(startSurface(styles, 'zh')).components.consent.label).toContain('同意');
  });

  it('shows progress while running and an error with restart when failed', () => {
    const running: EpicRunState = { run_id: 'r1', status: 'running', steps: [step(1, 'done'), step(2, 'running')], time_left: 'A few seconds to go.' };
    const surface = load(runSurface({ run: running, styles, proxy, lang: 'en' }));
    expect(surface.components.steps.component).toBe('StepList');
    expect((surface.data.steps as unknown[]).length).toBe(2);
    const failed = load(runSurface({ run: { ...running, status: 'failed', message: 'Boom' }, styles, proxy, lang: 'en' }));
    expect(failed.components.err.body).toBe('Boom');
    expect(failed.components.actions.actions?.[0].id).toBe('epic.new');
    expect(isTerminal({ ...running, status: 'failed' })).toBe(true);
    expect(isTerminal(running)).toBe(false);
  });

  it('builds the check surface only when a step waits on the user and a card exists', () => {
    const run: EpicRunState = { run_id: 'r1', status: 'waiting_play_card', steps: [step(3, 'done'), step(4, 'waiting_user')] };
    const card: EpicPlayCard = {
      run_id: 'r1',
      play_sheet: {
        activity: { value: 'free kick' },
        outcome_summary: { value: 'Goal' },
        events: [{ id: 'e7', action: 'keeper stays' }, { id: 'e1', action: 'ignored' }],
        sensitive: { flag: false, checked: false }
      },
      climax: { frame: 313, t: 10.4 },
      other_moments: [{ frame: 289, t: 9.6, reason: 'strike' }],
      highlighted: ['climax', 'e7']
    };
    const surface = load(runSurface({ run, card, styles, proxy, lang: 'en' }));
    const frames = surface.components.gallery.frames as Array<{ frame: number; url: string }>;
    expect(frames.map(frame => frame.frame)).toEqual([313, 289]);
    expect(frames[0].url).toBe('/api/epic/runs/r1/frames/313.jpg');
    expect(surface.components.event_e7).toBeDefined();
    expect(surface.components.event_e1).toBeUndefined();
    expect(surface.components.clipok).toBeDefined();
    expect(surface.components.gallery.default).toBe(313);
    // without a card it stays on progress rather than showing an empty check
    expect(load(runSurface({ run, card: null, styles, proxy, lang: 'en' })).components.steps).toBeDefined();
  });

  it('builds the result surface with the video and the other narrators', () => {
    const run: EpicRunState = { run_id: 'r1', status: 'done', style: 'news_reporter', has_video: true, steps: [step(8, 'done')] };
    const surface = load(runSurface({ run, styles, proxy, lang: 'en' }));
    expect(surface.components.video.src).toBe('/api/epic/runs/r1/final.mp4');
    expect((surface.components.style.options as Array<{ value: string }>).map(option => option.value)).toEqual(['football_commentator']);
  });

  it('turns the form into the play-card answer', () => {
    const form = { climax_frame: 289, activity: ' kick ', outcome_summary: 'Goal', 'event:e7': false, player_name: 'Noa', clip_ok: true };
    expect(confirmBody('confirm', form)).toEqual({
      action: 'confirm',
      edits: { climax_frame: 289, clip_ok: true, activity: 'kick', outcome_summary: 'Goal', events: [{ id: 'e7', keep: false }] },
      context: { player_name: 'Noa' }
    });
    // generic takes the key moment and clip_ok only
    expect(confirmBody('generic', form)).toEqual({ action: 'generic', edits: { climax_frame: 289, clip_ok: true }, context: {} });
  });
});
