/**
 * Test-only page for e2e/homemindComponents.spec.ts: renders the Homemind screens through the real
 * builders and A2uiSurfaceView, without the Family tab (T3.2). Served by the Vite dev server only;
 * `vite build` never includes it. Query: ?lang=en|zh&member=mom|dad|maya.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fixedClock } from '../../server/homemind/clock';
import { applyChange } from '../../server/homemind/core';
import { seedState } from '../../server/homemind/seed';
import type { HomemindState } from '../../server/homemind/types';
import { viewFor } from '../../server/homemind/visibility';
import { A2uiSurfaceView } from '../../src/components/a2ui/A2uiSurfaceView';
import { I18nContext } from '../../src/i18n/I18nContext';
import { screenTurn } from '../../src/lib/homemindSurfaces';
import type { HomemindScreenName } from '../../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../../src/protocol/a2ui/store';
import type { A2uiAction } from '../../src/types';
import '../../src/styles.css';

const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const params = new URLSearchParams(window.location.search);
const lang = params.get('lang') === 'zh' ? 'zh' : 'en';
const member = ['mom', 'dad', 'maya'].includes(params.get('member') ?? '') ? (params.get('member') as string) : 'mom';
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

function state(): HomemindState {
  const clock = fixedClock(NOW);
  let s = seedState({ now: NOW, timezone: 'Asia/Shanghai' });
  const r = applyChange(s, { kind: 'create', item: { type: 'task', title: 'Bring apples', forMemberIds: ['noa'], source: { kind: 'group', label: 'Kindergarten group', simulated: true } } as never }, 'mom', clock);
  if (r.ok) s = r.state;
  const w = applyChange(
    s,
    { kind: 'create', item: { type: 'event', title: lang === 'zh' ? '婚礼' : 'Wedding', start: new Date(NOW + 86_400_000).toISOString(), end: new Date(NOW + 86_400_000 + 4 * 3600_000).toISOString(), forMemberIds: ['mom'], unavailableMemberIds: ['mom'] } as never },
    'mom',
    clock
  );
  if (w.ok) s = w.state;
  const card = { id: 'card-1', adapter: 'pizza', mode: 'simulated' as const, payload: { title: lang === 'zh' ? '周五披萨' : 'Friday pizza', summary: lang === 'zh' ? '1 个大号玛格丽特，88 元' : '1 large margherita, 88 CNY' }, payloadHash: 'h', status: 'pending' as const, expiresAt: new Date(NOW + 3600_000).toISOString(), whyId: 'why-1' };
  return { ...s, actionCards: [card] };
}

const SCREENS: HomemindScreenName[] = ['my-day', 'family', 'calendar'];

function Harness() {
  const [last, setLast] = useState('');
  const s = state();
  const view = viewFor(s, member)!;
  const surfaces = SCREENS.map(screen => A2uiSurfaceStore.fromJsonl(screenTurn(screen, { lang, now: new Date(NOW).toISOString(), view }).jsonl).list()[0]);
  const tr = (en: string, zh: string) => (lang === 'zh' ? zh : en);
  const onAction = (action: A2uiAction) => setLast(JSON.stringify({ id: action.id, args: action.args }));
  return (
    <I18nContext.Provider value={{ lang, setLang: () => {}, tr, locale: lang === 'zh' ? 'zh-CN' : 'en-US' }}>
      <main>
        <output data-testid="last-action">{last}</output>
        {surfaces.map(surface => (
          <div key={surface.id} data-screen={surface.id}>
            <A2uiSurfaceView surface={surface} onAction={onAction} />
          </div>
        ))}
      </main>
    </I18nContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
