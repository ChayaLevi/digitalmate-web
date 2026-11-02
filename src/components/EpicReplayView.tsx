import { useCallback, useEffect, useRef, useState } from 'react';
import { A2uiSurfaceView } from './a2ui/A2uiSurfaceView';
import { A2uiSurfaceStore } from '../protocol/a2ui/store';
import { parseA2uiJsonl } from '../protocol/a2ui/parser';
import { confirmBody, EPIC_SURFACE_ID } from '../lib/epicSurface';
import type { A2uiAction, A2uiSurface } from '../types';
import { useI18n } from '../i18n/I18nContext';

const RUN_KEY = 'dm.epic.run';

function readRun(): string | null {
  try {
    return window.localStorage.getItem(RUN_KEY);
  } catch {
    return null;
  }
}

function writeRun(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(RUN_KEY, id);
    else window.localStorage.removeItem(RUN_KEY);
  } catch {
    /* storage unavailable: the run just will not survive a reload */
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (typeof body.error === 'string') return body.error;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/**
 * Epic Replay inside DigitalMate. The whole flow is driven by A2UI surfaces that the bridge
 * builds from the Epic Replay server: start form, progress, the "is this what happened" check,
 * and the finished video. This component only renders them and sends the user's actions back.
 */
export function EpicReplayView({ onNotice }: { onNotice: (message: string) => void }) {
  const { lang, tr } = useI18n();
  const store = useRef(new A2uiSurfaceStore());
  const stage = useRef('');
  const [surface, setSurface] = useState<A2uiSurface | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(readRun);
  const [showPast, setShowPast] = useState(false);

  const apply = useCallback((text: string) => {
    const parsed = parseA2uiJsonl(text);
    for (const envelope of parsed.envelopes) store.current.apply(envelope);
    const next = store.current.get(EPIC_SURFACE_ID);
    if (!next) return;
    const nextStage = String((next.data as { stage?: string }).stage ?? '');
    const changed = nextStage !== stage.current;
    stage.current = nextStage;
    setSurface(next);
    setForm(previous => {
      const base = changed ? {} : { ...previous };
      for (const component of Object.values(next.components)) {
        const name = typeof component.name === 'string' ? component.name : '';
        if (name && component.default !== undefined && base[name] === undefined) base[name] = component.default;
      }
      return base;
    });
  }, []);

  const loadStart = useCallback(async () => {
    try {
      const res = await fetch(`/api/epic/start?lang=${lang}`);
      apply(await res.text());
    } catch {
      onNotice(tr('Could not reach the DigitalMate bridge.', '无法连接 DigitalMate 桥接服务。'));
    }
  }, [apply, lang, onNotice, tr]);

  const loadPast = useCallback(async () => {
    try {
      const res = await fetch(`/api/epic/past?lang=${lang}`);
      if (!res.ok) return onNotice(await errorText(res));
      apply(await res.text());
    } catch {
      onNotice(tr('Could not reach the DigitalMate bridge.', '无法连接 DigitalMate 桥接服务。'));
    }
  }, [apply, lang, onNotice, tr]);

  useEffect(() => {
    if (runId) return undefined;
    void (showPast ? loadPast() : loadStart());
    return undefined;
  }, [runId, showPast, loadStart, loadPast]);

  useEffect(() => {
    if (!runId) return undefined;
    const source = new EventSource(`/api/epic/runs/${runId}/stream?lang=${lang}`);
    source.onmessage = event => apply(event.data);
    source.addEventListener('end', () => source.close());
    return () => source.close();
  }, [runId, lang, apply]);

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const onAction = async (action: A2uiAction) => {
    if (busy) return;
    setBusy(true);
    try {
      if (action.id === 'epic.past') {
        writeRun(null);
        stage.current = '';
        setForm({});
        setRunId(null);
        setShowPast(true);
        if (!runId && showPast) await loadPast();
        return;
      }
      if (action.id.startsWith('epic.open:')) {
        const id = action.id.slice('epic.open:'.length);
        writeRun(id);
        stage.current = '';
        setShowPast(false);
        setRunId(id);
        return;
      }
      if (action.id === 'epic.new') {
        setShowPast(false);
        writeRun(null);
        stage.current = '';
        setRunId(null);
        setForm({});
        await loadStart();
        return;
      }
      if (action.id === 'epic.start') {
        const file = form.file;
        if (!(file instanceof File)) return onNotice(tr('Choose a clip first.', '请先选择视频。'));
        if (form.consent !== true) return onNotice(tr('Tick the consent box first.', '请先勾选同意。'));
        const data = new FormData();
        data.append('consent', 'true');
        data.append('keep_original_audio', form.mute === true ? 'false' : 'true');
        data.append('style', String(form.style ?? ''));
        data.append('language', String(form.language ?? lang));
        const player = String(form.player_name ?? '').trim();
        if (player) data.append('player_name', player);
        data.append('file', file);
        const res = await fetch('/api/epic/runs', { method: 'POST', body: data });
        if (!res.ok) return onNotice(await errorText(res));
        const { run_id: id } = (await res.json()) as { run_id: string };
        writeRun(id);
        stage.current = '';
        setRunId(id);
        return;
      }
      if (!runId) return;
      const target = `/api/epic/runs/${runId}/action`;
      let res: Response | null = null;
      if (action.id === 'epic.confirm') res = await post(target, confirmBody('confirm', form));
      else if (action.id === 'epic.generic') res = await post(target, confirmBody('generic', form));
      else if (action.id === 'epic.reject') res = await post(target, { action: 'reject' });
      else if (action.id === 'epic.restyle') res = await post(target, { action: 'restyle', style: form.style });
      else if (action.id === 'epic.delete') res = await post(target, { action: 'delete' });
      if (!res) return;
      if (!res.ok) return onNotice(await errorText(res));
      if (action.id === 'epic.restyle') {
        const { run_id: id } = (await res.json()) as { run_id: string };
        writeRun(id);
        stage.current = '';
        setRunId(id);
      }
      if (action.id === 'epic.delete') {
        writeRun(null);
        stage.current = '';
        setRunId(null);
        onNotice(tr('Run deleted.', '已删除。'));
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : tr('Something went wrong.', '出错了。'));
    } finally {
      setBusy(false);
    }
  };

  if (!surface) return <p className="settings-note">{tr('Loading Epic Replay…', '正在加载 Epic Replay…')}</p>;
  return (
    <div className="epic-view" aria-busy={busy} data-stage={stage.current.split(':')[0]}>
      <A2uiSurfaceView
        surface={surface}
        onAction={action => void onAction(action)}
        form={form}
        onInput={(name, value) => setForm(previous => ({ ...previous, [name]: value }))}
      />
    </div>
  );
}
