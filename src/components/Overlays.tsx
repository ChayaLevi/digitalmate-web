import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FeedCard, Language, MemoryProfile, Message, Reaction, Settings, Skill, Artifact, TaskRecord } from '../types';
import { Icon } from './Icons';
import { BeeBou } from './BeeBou';
import { renderMarkdown } from '../lib/markdown';
import { collectBackup, formatBytes, restoreBackup, serializeBackup, summarizeBackup } from '../lib/backup';
import { STORAGE_KEYS } from '../lib/storage';
import { createSkillBundle, parseSkillBundle, serializeSkillBundle } from '../lib/skillBundle';
import { artifactDownloadContent, artifactFilename, artifactSlides } from '../lib/artifacts';
import { parseMemoryProfile } from '../lib/memoryProfile';
import { coverForCard, fallbackCoverForCard } from '../lib/covers';
import { cardKind } from '../lib/discoveryExperience';
import { requestNativeNotificationPermission } from '../lib/native';
import {
  clearDiagnostics,
  isDiagnosticsEnabled,
  readDiagnostics,
  serializeDiagnostics,
  setDiagnosticsEnabled
} from '../lib/diagnostics';
import { A2uiSurfaceView } from './a2ui/A2uiSurfaceView';
import { orbitHealth, resetOrbitSession } from '../transport/orbit';
import type { OrbitHealth } from '../transport/orbit';
import { checkLatestRelease, isNewerVersion } from '../lib/update';
import type { ReleaseInfo } from '../lib/update';
import { useI18n } from '../i18n/I18nContext';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  wide
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { tr } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.focus();

    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter(element => element.offsetParent !== null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="sheet-backdrop" onClick={onClose} aria-label={tr('Close', '关闭')} tabIndex={-1} />
      <section
        className={`sheet-panel ${wide ? 'is-wide' : ''}`}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="sheet-grabber" />
        <header className="sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={tr('Close', '关闭')}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sheet-content">{children}</div>
      </section>
    </div>
  );
}

type NavTab = 'chat' | 'discover' | 'family';

export function BottomNav({ tab, onTab, showFamily = false }: { tab: NavTab; onTab: (tab: NavTab) => void; showFamily?: boolean }) {
  const { tr } = useI18n();
  return (
    <nav className={`bottom-nav ${tab === 'discover' ? 'is-glass' : ''}`} aria-label={tr('Main navigation', '主导航')}>
      <button
        type="button"
        className={`nav-item ${tab === 'chat' ? 'is-active' : ''}`}
        onClick={() => onTab('chat')}
        aria-current={tab === 'chat' ? 'page' : undefined}
      >
        <Icon name="chat" size={22} />
        <span>{tr('Chat', '对话')}</span>
      </button>
      <button
        type="button"
        className={`nav-item ${tab === 'discover' ? 'is-active' : ''}`}
        onClick={() => onTab('discover')}
        aria-current={tab === 'discover' ? 'page' : undefined}
      >
        <Icon name="compass" size={22} />
        <span>{tr('Discover', '发现')}</span>
      </button>
      {/* Homemind: only when the bridge has it enabled. */}
      {showFamily ? (
        <button
          type="button"
          className={`nav-item ${tab === 'family' ? 'is-active' : ''}`}
          onClick={() => onTab('family')}
          aria-current={tab === 'family' ? 'page' : undefined}
        >
          <Icon name="calendar" size={22} />
          <span>{tr('Family', '家庭')}</span>
        </button>
      ) : null}
    </nav>
  );
}

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <span className="toast-dot" />
      {message}
    </div>
  );
}

export function HistorySheet({
  messages,
  onClose,
  onSelect,
  onNewChat
}: {
  messages: Message[];
  onClose: () => void;
  onSelect: () => void;
  onNewChat: () => void;
}) {
  const { tr, locale } = useI18n();
  const turns = useMemo(() => {
    const result: { id: string; prompt: string; reply: string; time: number }[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      const next = messages[index + 1];
      result.push({
        id: message.id,
        prompt: message.text,
        reply: next?.text?.slice(0, 80) ?? tr('Task submitted', '任务已提交'),
        time: message.createdAt
      });
    }
    return result.reverse();
  }, [messages]);

  return (
    <Sheet title={tr('History', '历史记录')} subtitle={tr(`${turns.length} tasks · saved locally`, `${turns.length} 个任务 · 本地保存`)} onClose={onClose}>
      <button type="button" className="primary-action full" onClick={onNewChat}>
        <Icon name="plus" size={16} />
        {tr('Start a new chat', '开始新对话')}
      </button>
      {turns.length === 0 ? (
        <div className="empty-state compact">
          <div className="empty-orb">
            <Icon name="clock" size={22} />
          </div>
          <strong>{tr('No history yet', '还没有历史任务')}</strong>
          <p>{tr('Tasks you start from the home screen will appear here.', '从首页发起一个任务后，会出现在这里。')}</p>
        </div>
      ) : (
        <div className="history-list">
          {turns.map(turn => (
            <button type="button" className="history-row" key={turn.id} onClick={onSelect}>
              <span className="history-icon">
                <Icon name="chat" size={16} />
              </span>
              <span className="history-copy">
                <strong>{turn.prompt}</strong>
                <em>{turn.reply}</em>
                <time>
                  {new Date(turn.time).toLocaleString(locale, {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </time>
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function MoreSheet({
  onClose,
  onSkills,
  onMemory,
  onHistory,
  onSettings,
  onNewChat,
  onDemo,
  onProtocol,
  onArtifacts,
  onTasks,
  onLabs
}: {
  onClose: () => void;
  onSkills: () => void;
  onMemory: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onNewChat: () => void;
  onDemo: () => void;
  onProtocol: () => void;
  onArtifacts: () => void;
  onTasks: () => void;
  onLabs: () => void;
}) {
  const { tr } = useI18n();
  const items = [
    { icon: 'play' as const, title: tr('Guided demo', '引导演示'), subtitle: tr('Run the 2-minute walkthrough automatically', '自动播放两分钟演示流程'), onClick: onDemo },
    { icon: 'grid' as const, title: tr('A2UI protocol demo', 'A2UI 协议演示'), subtitle: tr('Render a surface parsed from JSONL envelopes', '渲染由 JSONL 信封解析出的界面'), onClick: onProtocol },
    { icon: 'clock' as const, title: tr('Sessions & tasks', '会话与任务'), subtitle: tr('Local task rows with retry and details', '本地任务行，可重试与查看详情'), onClick: onTasks },
    { icon: 'bookmark' as const, title: tr('Artifacts', '成果'), subtitle: tr('Saved replies with local preview and export', '已保存的回复，可本地预览与导出'), onClick: onArtifacts },
    { icon: 'grid' as const, title: tr('Labs', '实验室'), subtitle: tr('BIM, multi-task, maps and demo flows', 'BIM、多任务、地图与演示流程'), onClick: onLabs },
    { icon: 'spark' as const, title: tr('Skill center', '技能中心'), subtitle: tr('Install, enable and manage skills', '安装、启用和管理技能'), onClick: onSkills },
    { icon: 'heart' as const, title: tr('About you', '关于你'), subtitle: tr('Long-term memory and public profile', '长期记忆与公开画像'), onClick: onMemory },
    { icon: 'clock' as const, title: tr('History', '历史记录'), subtitle: tr('Return to a previous task', '回到之前完成的任务'), onClick: onHistory },
    { icon: 'settings' as const, title: tr('Settings', '设置'), subtitle: tr('Connections, notifications and demo options', '连接、通知和演示选项'), onClick: onSettings },
    { icon: 'plus' as const, title: tr('Start a new chat', '开始新对话'), subtitle: tr('Clear the current thread, keep history', '清空当前消息，保留历史记录'), onClick: onNewChat }
  ];

  return (
    <Sheet title={tr('More', '更多')} subtitle={tr('DigitalMate Web · local demo', 'DigitalMate Web · 本地演示')} onClose={onClose}>
      <div className="menu-list">
        {items.map(item => (
          <button type="button" className="menu-row" key={item.title} onClick={item.onClick}>
            <span className="menu-icon">
              <Icon name={item.icon} size={18} />
            </span>
            <span className="menu-copy">
              <strong>{item.title}</strong>
              <em>{item.subtitle}</em>
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
      <div className="sheet-footnote">
        <Icon name="info" size={14} />
        {tr(
          'A web re-creation of the DigitalMate HarmonyOS client. It is not connected to a real Orbit service.',
          '这是对 DigitalMate 鸿蒙客户端的 Web 交互复刻，不连接真实 Orbit 服务。'
        )}
      </div>
    </Sheet>
  );
}

function skillActionLabel(skill: Skill, tr: (en: string, zh: string) => string): string {
  if (!skill.installed) return tr('Install', '安装');
  return skill.enabled ? tr('Enabled', '已启用') : tr('Disabled', '已停用');
}

export function SkillsSheet({
  skills,
  onClose,
  onToggle,
  onUninstall,
  onImport,
  onNotice
}: {
  skills: Skill[];
  onClose: () => void;
  onToggle: (id: string) => void;
  onUninstall: (id: string) => void;
  onImport: (skills: Skill[]) => void;
  onNotice: (message: string) => void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const categories = ['All', ...Array.from(new Set(skills.map(skill => skill.category)))];
  const installedCount = skills.filter(skill => skill.installed).length;

  const exportSkills = () => {
    const bundle = createSkillBundle(skills);
    const blob = new Blob([serializeSkillBundle(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `digitalmate-skills-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice(
      tr(
        `Exported ${bundle.skills.length} skills as a local publish bundle. No OAuth or account was used.`,
        `已将 ${bundle.skills.length} 个技能导出为本地发布包，不使用 OAuth 或账号。`
      )
    );
  };

  const importSkills = async (file: File) => {
    try {
      const imported = parseSkillBundle(await file.text());
      onImport(imported);
      onNotice(
        tr(`Imported ${imported.length} skills locally.`, `已在本地导入 ${imported.length} 个技能。`)
      );
    } catch (error) {
      onNotice(
        tr(
          `Could not import skills: ${error instanceof Error ? error.message : 'invalid file'}`,
          `无法导入技能：${error instanceof Error ? error.message : '文件无效'}`
        )
      );
    }
  };

  const visible = skills.filter(skill => {
    if (category !== 'All' && skill.category !== category) return false;
    if (query.trim() && !`${skill.name}${skill.description}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <Sheet title={tr('Skill center', '技能中心')} subtitle={tr(`${installedCount} installed · ${skills.length} available`, `${installedCount} 个已安装 · ${skills.length} 个可用`)} onClose={onClose} wide>
      <div className="search-field">
        <Icon name="search" size={17} />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={tr('Search skills or capabilities', '搜索技能或能力')}
          aria-label={tr('Search skills', '搜索技能')}
        />
      </div>
      <div className="filter-row">
        {categories.map(item => (
          <button
            type="button"
            key={item}
            className={`filter-chip ${category === item ? 'is-active' : ''}`}
            onClick={() => setCategory(item)}
          >
            {item === 'All' ? tr('All', '全部') : item}
          </button>
        ))}
      </div>
      <div className="settings-actions">
        <button type="button" className="secondary-action" onClick={exportSkills}>
          <Icon name="download" size={14} />
          {tr('Export / publish bundle', '导出 / 发布包')}
        </button>
        <button type="button" className="secondary-action" onClick={() => importRef.current?.click()}>
          <Icon name="download" size={14} />
          {tr('Import skills', '导入技能')}
        </button>
      </div>
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        className="hidden-file-input skill-import-input"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importSkills(file);
        }}
      />
      <div className="skill-list">
        {visible.map(skill => (
          <article className={`skill-card ${skill.installed ? 'is-installed' : ''}`} key={skill.id}>
            <span className="skill-icon">{skill.icon}</span>
            <div className="skill-copy">
              <div className="skill-title-row">
                <strong>{skill.name}</strong>
                {skill.builtin ? <span className="builtin-tag">{tr('Built-in', '内置')}</span> : null}
                <span className="skill-category">{skill.category}</span>
              </div>
              <p>{skill.description}</p>
              <span className="skill-author">{tr(`by ${skill.author}`, `作者 ${skill.author}`)}</span>
              <button
                type="button"
                className="skill-detail-link"
                onClick={() => setExpandedId(current => (current === skill.id ? null : skill.id))}
              >
                {expandedId === skill.id ? tr('Hide details', '收起详情') : tr('View details', '查看详情')}
                <Icon name={expandedId === skill.id ? 'chevronDown' : 'chevronRight'} size={11} />
              </button>
            </div>
            <div className="skill-actions">
              <button
                type="button"
                className={`skill-toggle ${skill.installed && skill.enabled ? 'is-on' : ''}`}
                onClick={() => {
                  onToggle(skill.id);
                  onNotice(skill.installed ? (skill.enabled ? tr(`Disabled ${skill.name}`, `已停用 ${skill.name}`) : tr(`Enabled ${skill.name}`, `已启用 ${skill.name}`)) : tr(`Installed ${skill.name}`, `已安装 ${skill.name}`));
                }}
              >
                {skillActionLabel(skill, tr)}
              </button>
              {skill.installed && !skill.builtin ? (
                <button type="button" className="skill-remove" onClick={() => onUninstall(skill.id)}>
                  {tr('Uninstall', '卸载')}
                </button>
              ) : null}
            </div>
            {expandedId === skill.id ? (
              <div className="skill-detail">
                <div className="info-rows">
                  <div className="info-row">
                    <span>{tr('Category', '分类')}</span>
                    <strong>{skill.category}</strong>
                  </div>
                  <div className="info-row">
                    <span>{tr('Author', '作者')}</span>
                    <strong>{skill.author}</strong>
                  </div>
                  <div className="info-row">
                    <span>{tr('Source', '来源')}</span>
                    <strong>{skill.builtin ? tr('Built-in', '内置') : tr('Local / imported', '本地 / 导入')}</strong>
                  </div>
                  <div className="info-row">
                    <span>{tr('Version', '版本')}</span>
                    <strong>{skill.version ?? '1.0.0'}</strong>
                  </div>
                  <div className="info-row">
                    <span>{tr('Status', '状态')}</span>
                    <strong>{skill.installed ? (skill.enabled ? tr('Enabled', '已启用') : tr('Disabled', '已停用')) : tr('Not installed', '未安装')}</strong>
                  </div>
                </div>
                <div className="skill-capabilities">
                  <span className="settings-label">{tr('Capabilities', '能力')}</span>
                  <div className="tag-row">
                    {(skill.capabilities ?? [tr('Runs locally in this demo', '在本地演示中运行')]).map(capability => (
                      <span className="mini-tag" key={capability}>
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="settings-note">
                  {tr(
                    'Skills are local metadata in this demo. No marketplace download, OAuth or account permission is used.',
                    '演示版中的技能只是本地元数据，不会从市场下载，也不使用 OAuth 或账号权限。'
                  )}
                </p>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {visible.length === 0 ? <p className="muted-note">{tr('No matching skills.', '没有匹配的技能。')}</p> : null}
      <div className="sheet-footnote">
        <Icon name="shield" size={14} />
        {tr(
          'In the real client, install state and permissions come from the cloud skill service; this is a local demo.',
          '真实版本的技能安装状态与权限由云端技能服务返回；这里只做本地演示。'
        )}
      </div>
    </Sheet>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function SettingsSheet({
  settings,
  onChange,
  onClose,
  onReset,
  onNotice,
  onLanguageChange,
  savedCount,
  messageCount,
  onOpenPersona,
  onOpenModel,
  onOpenProject,
  onOpenCapabilities
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  onReset: () => void;
  onNotice: (message: string) => void;
  onLanguageChange: (language: Language) => void;
  savedCount: number;
  messageCount: number;
  onOpenPersona: () => void;
  onOpenModel: () => void;
  onOpenProject: () => void;
  onOpenCapabilities: () => void;
}) {
  const { tr, lang } = useI18n();
  const [orbitStatus, setOrbitStatus] = useState<OrbitHealth | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [diagnosticsOn, setDiagnosticsOn] = useState(() => isDiagnosticsEnabled());
  const [diagnostics, setDiagnostics] = useState(() => readDiagnostics());
  const [release, setRelease] = useState<ReleaseInfo | null | undefined>(undefined);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    orbitHealth()
      .then(status => {
        if (active) setOrbitStatus(status);
      })
      .catch(() => {
        if (active) setOrbitStatus(null);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then(registration => setOfflineReady(Boolean(registration?.active)))
        .catch(() => setOfflineReady(false));
    }
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let active = true;
    navigator.serviceWorker
      .getRegistration()
      .then(registration => {
        if (!active || !registration) return;
        if (registration.waiting) setUpdateReady(true);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const checkForUpdates = async () => {
    if (!('serviceWorker' in navigator)) {
      onNotice(tr('Offline updates require a production build.', '离线更新需要生产构建。'));
      return;
    }
    setCheckingUpdate(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        onNotice(
          tr(
            'No offline cache is registered in development. Use the production build to test updates.',
            '开发模式未注册离线缓存，请使用生产构建测试更新。'
          )
        );
        return;
      }
      await registration.update();
      if (registration.waiting || registration.installing) {
        setUpdateReady(true);
      } else {
        onNotice(tr('You are up to date.', '已是最新版本。'));
      }
    } catch {
      onNotice(tr('Could not check for updates.', '无法检查更新。'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const storageBytes = (() => {
    try {
      let total = 0;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key) continue;
        total += key.length + (window.localStorage.getItem(key)?.length ?? 0);
      }
      return total * 2;
    } catch {
      return 0;
    }
  })();

  const checkRelease = async () => {    setReleaseBusy(true);
    setReleaseError('');
    try {
      const latest = await checkLatestRelease();
      setRelease(latest);
      if (!latest) setReleaseError(tr('No public release was found yet.', '还没有找到公开版本。'));
    } catch {
      setReleaseError(tr('Could not reach the release server.', '无法连接版本服务器。'));
    } finally {
      setReleaseBusy(false);
    }
  };

  const downloadBackup = () => {
    const backup = collectBackup(window.localStorage);
    const summary = summarizeBackup(backup);
    const blob = new Blob([serializeBackup(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `digitalmate-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice(
      tr(
        `Exported ${summary.keys} keys (${formatBytes(summary.bytes)}).`,
        `已导出 ${summary.keys} 项数据（${formatBytes(summary.bytes)}）。`
      )
    );
  };

  const importBackup = async (file: File) => {
    try {
      const summary = restoreBackup(window.localStorage, await file.text());
      onNotice(
        tr(
          `Imported ${summary.keys} keys (${formatBytes(summary.bytes)}). Reloading…`,
          `已导入 ${summary.keys} 项数据（${formatBytes(summary.bytes)}），即将刷新…`
        )
      );
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      onNotice(
        tr(
          `Could not import backup: ${error instanceof Error ? error.message : 'invalid file'}`,
          `无法导入备份：${error instanceof Error ? error.message : '文件无效'}`
        )
      );
    }
  };

  const downloadDiagnostics = () => {
    const entries = readDiagnostics();
    if (entries.length === 0) return;
    const blob = new Blob([serializeDiagnostics(entries)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `digitalmate-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDiagnostics(entries);
    onNotice(
      tr(
        `Exported ${entries.length} local diagnostic entries.`,
        `已导出 ${entries.length} 条本地诊断记录。`
      )
    );
  };

  const clearDiagnosticLog = () => {
    clearDiagnostics();
    setDiagnostics([]);
    onNotice(tr('Local diagnostic log cleared.', '本地诊断日志已清除。'));
  };

  return (
    <Sheet title={tr('Settings', '设置')} subtitle={tr('Local demo · nothing is uploaded', '本地演示 · 不会上传任何数据')} onClose={onClose} wide>
      <div className="account-card">
        <span className="account-avatar">{lang === 'zh' ? '林' : 'L'}</span>
        <div>
          <strong>{tr('Lin Wei', '林未')}</strong>
          <span>{tr('Local demo account · Shenzhen', '本地演示账号 · 深圳')}</span>
        </div>
        <span className="connection-pill is-demo">
          <span className="connection-dot" />
          {tr('Local demo', '本地演示')}
        </span>
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Language', '语言')}</span>
        <div className="segmented">
          <button
            type="button"
            className={lang === 'en' ? 'is-active' : ''}
            onClick={() => onLanguageChange('en')}
          >
            English
          </button>
          <button
            type="button"
            className={lang === 'zh' ? 'is-active' : ''}
            onClick={() => onLanguageChange('zh')}
          >
            中文
          </button>
        </div>
        <p className="settings-note">
          {tr('Switching language resets the current conversation and discovery feed so everything uses the selected language.', '切换语言会重置当前对话和发现流，确保所有内容使用所选语言。')}
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Workspace', '工作区')}</span>
        <div className="settings-actions">
          <button type="button" className="secondary-action" onClick={onOpenPersona}>
            <Icon name="user" size={14} />
            {tr('Companion', '分身')}
          </button>
          <button type="button" className="secondary-action" onClick={onOpenModel}>
            <Icon name="spark" size={14} />
            {tr('Model', '模型')}
          </button>
          <button type="button" className="secondary-action" onClick={onOpenProject}>
            <Icon name="grid" size={14} />
            {tr('Project', '项目')}
          </button>
          <button type="button" className="secondary-action" onClick={onOpenCapabilities}>
            <Icon name="plus" size={14} />
            {tr('Tools', '工具')}
          </button>
        </div>
        <p className="settings-note">
          {tr('These are the same local choices shown above the composer.', '这些选项与输入框上方的本地选择相同。')}
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Cloud connection', '云端连接')}</span>
        <div className="segmented">
          <button
            type="button"
            className={settings.cloudBackend === 'orbit' ? 'is-active' : ''}
            onClick={() => {
              onChange({ ...settings, cloudBackend: 'orbit' });
              onNotice(
                orbitStatus?.configured
                  ? tr(
                      `Orbit bridge selected · ${orbitStatus.gatewayHost}`,
                      `已选择 Orbit 桥接 · ${orbitStatus.gatewayHost}`
                    )
                  : tr(
                      'Orbit bridge is not configured; turns will fall back to the local mock.',
                      'Orbit 桥接未配置，对话会回退到本地模拟。'
                    )
              );
            }}
          >
            {tr('Orbit cloud', 'Orbit 云端')}
          </button>
          <button
            type="button"
            className={settings.cloudBackend === 'local' ? 'is-active' : ''}
            onClick={() => onChange({ ...settings, cloudBackend: 'local' })}
          >
            {tr('Local mode', '本地模式')}
          </button>
        </div>
        <p className="settings-note">
          {tr(
            'Orbit mode streams through the local bridge; the Bearer token stays on the server. Without bridge configuration, turns use the mock.',
            'Orbit 模式通过本地桥接串流，Bearer 令牌只保留在服务端。未配置桥接时，对话使用本地模拟。'
          )}
        </p>
        {settings.cloudBackend === 'orbit' ? (
          <div className={`orbit-status ${orbitStatus?.configured ? 'is-live' : 'is-off'}`}>
            <Icon name={orbitStatus?.configured ? 'wifi' : 'info'} size={14} />
            <span>
              {orbitStatus === null
                ? tr('Checking the bridge…', '正在检查桥接…')
                : orbitStatus.configured
                  ? tr(
                      `Bridge ready · ${orbitStatus.gatewayHost} · binding ${orbitStatus.bindingId}${orbitStatus.roomId ? ` · ${orbitStatus.roomId}` : ''} · delegated token`,
                      `桥接就绪 · ${orbitStatus.gatewayHost} · binding ${orbitStatus.bindingId}${orbitStatus.roomId ? ` · ${orbitStatus.roomId}` : ''} · 委托令牌`
                    )
                  : tr(
                      'Bridge not configured — set ORBIT_GATEWAY_URL and ORBIT_TOKEN on the server.',
                      '桥接未配置 — 请在服务端设置 ORBIT_GATEWAY_URL 和 ORBIT_TOKEN。'
                    )}
            </span>
          </div>
        ) : null}
        {settings.cloudBackend === 'orbit' && orbitStatus?.configured ? (
          <button
            type="button"
            className="secondary-action orbit-reset"
            onClick={async () => {
              try {
                await resetOrbitSession();
                setOrbitStatus(current => (current ? { ...current, roomId: undefined } : current));
                onNotice(tr('Bridge session cleared.', '桥接会话已清除。'));
              } catch {
                onNotice(tr('Could not clear the bridge session.', '无法清除桥接会话。'));
              }
            }}
          >
            <Icon name="refresh" size={14} />
            {tr('Reset bridge session', '重置桥接会话')}
          </button>
        ) : null}
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Account-free access', '免账号使用')}</span>
        <div className={`orbit-status ${online ? 'is-live' : 'is-off'}`}>
          <Icon name={online ? 'wifi' : 'info'} size={14} />
          <span>
            {online
              ? tr(
                  'Online · local mode always works without signing in.',
                  '在线 · 本地模式无需登录，始终可用。'
                )
              : tr(
                  'Offline · your local chats, calendar and settings still work.',
                  '离线 · 本地对话、日历和设置仍然可用。'
                )}
          </span>
        </div>
        <p className="settings-note">
          {tr(
            'No account is required. Chats, calendar events, saved cards and RSS subscriptions stay in this browser.',
            '无需账号。对话、日程、收藏卡片和 RSS 订阅都保存在当前浏览器。'
          )}
        </p>
        <div className="offline-line">
          <Icon name={offlineReady ? 'check' : 'download'} size={13} />
          <span>
            {offlineReady
              ? tr('Offline cache is active.', '离线缓存已启用。')
              : tr(
                  'Offline cache activates after a production build and first visit.',
                  '离线缓存会在生产构建并首次访问后启用。'
                )}
          </span>
        </div>
        <div className="offline-line">
          <Icon name="info" size={13} />
          <span>{tr(`Version ${__APP_VERSION__}`, `版本 ${__APP_VERSION__}`)}</span>
        </div>
        <div className="settings-actions">
          {updateReady ? (
            <button type="button" className="primary-action" onClick={() => window.location.reload()}>
              <Icon name="refresh" size={14} />
              {tr('Reload to update', '重新加载以更新')}
            </button>
          ) : (
            <button
              type="button"
              className="secondary-action"
              disabled={checkingUpdate}
              onClick={() => void checkForUpdates()}
            >
              <Icon name="refresh" size={14} />
              {checkingUpdate ? tr('Checking…', '检查中…') : tr('Check for updates', '检查更新')}
            </button>
          )}
        </div>
        {installPrompt ? (
          <button
            type="button"
            className="secondary-action orbit-reset"
            onClick={() => {
              const prompt = installPrompt;
              setInstallPrompt(null);
              void prompt.prompt().catch(() => undefined);
            }}
          >
            <Icon name="download" size={14} />
            {tr('Install app', '安装应用')}
          </button>
        ) : null}
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('App updates', '应用更新')}</span>
        <p className="settings-note">
          {tr(
            `Current version ${__APP_VERSION__}. The web build checks its offline cache; the Android build can also check GitHub releases.`,
            `当前版本 ${__APP_VERSION__}。网页构建会检查离线缓存；Android 构建还可以检查 GitHub 版本。`
          )}
        </p>
        <div className="settings-actions">
          <button type="button" className="secondary-action" disabled={releaseBusy} onClick={() => void checkRelease()}>
            <Icon name="refresh" size={14} />
            {releaseBusy ? tr('Checking…', '检查中…') : tr('Check GitHub release', '检查 GitHub 版本')}
          </button>
          {release?.url ? (
            <a className="secondary-action" href={release.url} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} />
              {tr('Release notes', '版本说明')}
            </a>
          ) : null}
        </div>
        {releaseError ? <p className="settings-note">{releaseError}</p> : null}
        {release ? (
          isNewerVersion(release.version, __APP_VERSION__) ? (
            <div className="release-card">
              <strong>{tr(`Version ${release.version} is available`, `有可用版本 ${release.version}`)}</strong>
              {release.notes ? <em>{release.notes}</em> : null}
              <a
                className="primary-action"
                href={release.apkUrl ?? release.url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="download" size={15} />
                {release.apkUrl ? tr('Download APK', '下载 APK') : tr('Open release', '打开发布页')}
              </a>
            </div>
          ) : (
            <p className="settings-note">
              {tr(`You are on the latest release (${release.version}).`, `已是最新版本（${release.version}）。`)}
            </p>
          )
        ) : null}
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Your data', '你的数据')}</span>
        <p className="settings-note">
          {tr(
            'Back up chats, calendar events, saved cards, RSS subscriptions and settings to a local JSON file. Nothing leaves this device.',
            '把对话、日程、收藏卡片、RSS 订阅和设置备份为本地 JSON 文件。数据不会离开这台设备。'
          )}
        </p>
        <div className="settings-actions">
          <button type="button" className="secondary-action" onClick={downloadBackup}>
            <Icon name="download" size={14} />
            {tr('Export backup', '导出备份')}
          </button>
          <button type="button" className="secondary-action" onClick={() => backupInput.current?.click()}>
            <Icon name="download" size={14} />
            {tr('Import backup', '导入备份')}
          </button>
        </div>
        <input
          ref={backupInput}
          type="file"
          accept="application/json,.json"
          className="hidden-file-input"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importBackup(file);
          }}
        />
        <p className="settings-note">
          {tr(
            'Import replaces the local DigitalMate data in this browser after a reload.',
            '导入后会替换当前浏览器中的 DigitalMate 本地数据，并自动刷新。'
          )}
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Experience', '体验')}</span>
        <Toggle
          label={tr('Task notifications', '任务通知')}
          description={tr('Notify when a task completes while the tab is in the background.', '任务在后台完成时发送系统通知。')}
          checked={settings.notifications}
          onChange={async value => {
            if (value) {
              const native = await requestNativeNotificationPermission();
              if (native === false) {
                onNotice(tr('Notification permission was not granted.', '未获得通知权限。'));
                return;
              }
              if (native === true) {
                onChange({ ...settings, notifications: true });
                return;
              }
            }
            if (value && typeof Notification !== 'undefined') {
              try {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                  onNotice(tr('Notification permission was not granted.', '未获得通知权限。'));
                  return;
                }
              } catch {
                onNotice(tr('Notifications are not available in this browser.', '当前浏览器不支持通知。'));
                return;
              }
            }
            onChange({ ...settings, notifications: value });
          }}
        />
        <Toggle
          label={tr('Show execution trace', '显示执行轨迹')}
          description={tr('Display planning, queries, merging and rendering steps.', '展示计划、查询、合并和渲染步骤。')}
          checked={settings.showThinking}
          onChange={value => onChange({ ...settings, showThinking: value })}
        />
        <Toggle
          label={tr('Reduce motion', '减少动效')}
          description={tr('Disable card entrance and streaming cursor animations.', '关闭卡片入场和流式光标动画。')}
          checked={settings.reducedMotion}
          onChange={value => onChange({ ...settings, reducedMotion: value })}
        />
        <Toggle
          label={tr('Speak replies', '朗读回复')}
          description={tr('Read assistant replies aloud with the system voice.', '使用系统语音朗读助手回复。')}
          checked={Boolean(settings.speakReplies)}
          onChange={value => onChange({ ...settings, speakReplies: value })}
        />
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Diagnostics', '诊断')}</span>
        <Toggle
          label={tr('Local error log', '本地错误日志')}
          description={tr(
            'Keep the last 20 app errors on this device. Nothing is uploaded.',
            '在本设备保留最近 20 条应用错误，不会上传任何内容。'
          )}
          checked={diagnosticsOn}
          onChange={value => {
            setDiagnosticsOn(value);
            setDiagnosticsEnabled(value);
            if (value) setDiagnostics(readDiagnostics());
          }}
        />
        <div className="offline-line">
          <Icon name="info" size={13} />
          <span>
            {diagnostics.length === 0
              ? tr('No errors recorded.', '暂无错误记录。')
              : diagnostics.length === 1
                ? tr('1 local entry stored.', '已保存 1 条本地记录。')
                : tr(
                    `${diagnostics.length} local entries stored.`,
                    `已保存 ${diagnostics.length} 条本地记录。`
                  )}
          </span>
        </div>
        <div className="offline-line">
          <Icon name="info" size={13} />
          <span>
            {tr(
              `${Math.max(1, Math.round(storageBytes / 1024))} KB stored · ${import.meta.env.PROD ? 'production' : 'development'} · ${navigator.onLine ? 'online' : 'offline'}`,
              `已存储 ${Math.max(1, Math.round(storageBytes / 1024))} KB · ${import.meta.env.PROD ? '生产' : '开发'} · ${navigator.onLine ? '在线' : '离线'}`
            )}
          </span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="secondary-action"
            disabled={diagnostics.length === 0}
            onClick={downloadDiagnostics}
          >
            <Icon name="download" size={14} />
            {tr('Export log', '导出日志')}
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={diagnostics.length === 0}
            onClick={clearDiagnosticLog}
          >
            <Icon name="trash" size={14} />
            {tr('Clear log', '清除日志')}
          </button>
        </div>
        <p className="settings-note">
          {tr(
            'Messages are sanitized to remove URLs, query tokens and bearer credentials. Export the JSON file only when you choose to share a bug report.',
            '记录会移除 URL、查询令牌和 Bearer 凭证。仅在您主动提交问题报告时导出 JSON 文件。'
          )}
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-label">{tr('Local data', '本地数据')}</span>
        <div className="data-row">
          <div>
            <strong>{tr(`${messageCount} messages`, `${messageCount} 条消息`)}</strong>
            <span>{tr(`${savedCount} saved · browser localStorage`, `${savedCount} 个收藏 · 浏览器 localStorage`)}</span>
          </div>
          <button type="button" className="danger-action" onClick={onReset}>
            <Icon name="trash" size={15} />
            {tr('Clear and reset', '清除并重置')}
          </button>
        </div>
        <div className="settings-actions">
          {[
            { label: tr('Clear saved cards', '清除收藏'), key: STORAGE_KEYS.savedCards },
            { label: tr('Clear RSS feeds', '清除 RSS'), key: STORAGE_KEYS.rssCards },
            { label: tr('Clear read state', '清除已读'), key: STORAGE_KEYS.readCards },
            { label: tr('Clear tasks', '清除任务'), key: STORAGE_KEYS.tasks }
          ].map(item => (
            <button
              type="button"
              className="secondary-action"
              key={item.key}
              onClick={() => {
                if (!window.confirm(tr('Remove this local dataset?', '确定清除这份本地数据？'))) return;
                window.localStorage.removeItem(item.key);
                window.location.reload();
              }}
            >
              <Icon name="trash" size={13} />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="about-card">
        <div className="about-head">
          <span className="about-mark"><BeeBou size={32} still className="is-mini" decorative /></span>
          <div>
            <strong>DigitalMate Web</strong>
            <span>{tr(`v${__APP_VERSION__} · account-free`, `v${__APP_VERSION__} · 免账号`)}</span>
          </div>
        </div>
        <p>
          {tr(
            'A web re-creation of the DigitalMate HarmonyOS client’s A2UI protocol, theme and interaction structure. Not the official client, and it contains no real Gateway credentials.',
            '基于 DigitalMate 鸿蒙客户端的 A2UI 协议、主题与交互结构复刻。不是官方客户端，也不包含真实 Gateway 凭证。'
          )}
        </p>
        <a href="https://github.com/openJiuwen-ai/DigitalMate" target="_blank" rel="noreferrer">
          {tr('View original project', '查看原始项目')}
          <Icon name="external" size={14} />
        </a>
      </div>
    </Sheet>
  );
}

function cloneProfile(profile: MemoryProfile): MemoryProfile {
  return {
    ...profile,
    tags: [...profile.tags],
    sections: profile.sections.map(section => ({ ...section }))
  };
}

export function MemorySheet({
  profile,
  onSave,
  onForget,
  onClose,
  onNotice,
  personaName
}: {
  profile: MemoryProfile;
  onSave: (profile: MemoryProfile) => void;
  onForget: () => void;
  onClose: () => void;
  onNotice: (message: string) => void;
  personaName?: string;
}) {
  const { tr, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MemoryProfile>(() => cloneProfile(profile));
  const [tagText, setTagText] = useState(profile.tags.join(', '));
  const importRef = useRef<HTMLInputElement>(null);

  const importProfile = async (file: File) => {
    try {
      const imported = parseMemoryProfile(await file.text());
      onSave(imported);
      setDraft(cloneProfile(imported));
      setTagText(imported.tags.join(', '));
      onNotice(tr('Public profile imported locally.', '公开画像已在本地导入。'));
    } catch (error) {
      onNotice(
        tr(
          `Could not import profile: ${error instanceof Error ? error.message : 'invalid file'}`,
          `无法导入画像：${error instanceof Error ? error.message : '文件无效'}`
        )
      );
    }
  };

  const startEdit = () => {
    setDraft(cloneProfile(profile));
    setTagText(profile.tags.join(', '));
    setEditing(true);
  };

  const save = () => {
    const next: MemoryProfile = {
      ...draft,
      name: draft.name.trim() || tr('You', '你'),
      tags: tagText
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean),
      sections: draft.sections
        .filter(section => section.title.trim() || section.body.trim())
        .map(section => ({
          title: section.title.trim() || tr('Untitled', '未命名'),
          body: section.body.trim(),
          evidence: section.evidence?.trim() || undefined
        }))
    };
    onSave(next);
    setDraft(next);
    setEditing(false);
  };

  return (
    <Sheet
      title={tr('About you', '关于你')}
      subtitle={
        personaName
          ? tr(`Long-term memory · ${personaName}`, `长期记忆 · ${personaName}`)
          : tr('Long-term memory · local only, no account', '长期记忆 · 仅本地，无需账号')
      }
      onClose={onClose}
      wide
    >
      <div className="memory-head">
        <span className="memory-avatar">{lang === 'zh' ? '林' : 'L'}</span>
        <div>
          <h3>{editing ? draft.name || tr('You', '你') : profile.name}</h3>
          <p>{editing ? draft.headline : profile.headline}</p>
        </div>
        <span className="mbti-pill">{editing ? draft.mbti || '—' : profile.mbti}</span>
      </div>

      {editing ? (
        <div className="memory-edit">
          <div className="field-row">
            <label className="field">
              <span>{tr('Name', '称呼')}</span>
              <input
                value={draft.name}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                placeholder={tr('Your name', '你的称呼')}
              />
            </label>
            <label className="field">
              <span>MBTI</span>
              <input
                value={draft.mbti}
                onChange={event => setDraft(current => ({ ...current, mbti: event.target.value }))}
                placeholder="INTJ"
              />
            </label>
          </div>
          <label className="field">
            <span>{tr('Headline', '一句话介绍')}</span>
            <input
              value={draft.headline}
              onChange={event => setDraft(current => ({ ...current, headline: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{tr('Summary', '摘要')}</span>
            <textarea
              rows={3}
              value={draft.summary}
              onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{tr('Tags (comma separated)', '标签（用逗号分隔）')}</span>
            <input value={tagText} onChange={event => setTagText(event.target.value)} />
          </label>

          <div className="memory-edit-head">
            <span className="settings-label">{tr('Details', '详细记忆')}</span>
            <button
              type="button"
              className="ghost-action"
              onClick={() =>
                setDraft(current => ({
                  ...current,
                  sections: [...current.sections, { title: '', body: '' }]
                }))
              }
            >
              <Icon name="plus" size={12} />
              {tr('Add section', '添加分组')}
            </button>
          </div>
          {draft.sections.map((section, index) => (
            <div className="memory-section-edit" key={`section-${index}`}>
              <div className="memory-section-edit-head">
                <input
                  value={section.title}
                  placeholder={tr('Section title', '分组标题')}
                  aria-label={tr('Section title', '分组标题')}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      sections: current.sections.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, title: event.target.value } : item
                      )
                    }))
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={tr('Remove section', '删除分组')}
                  onClick={() =>
                    setDraft(current => ({
                      ...current,
                      sections: current.sections.filter((_, itemIndex) => itemIndex !== index)
                    }))
                  }
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              <textarea
                rows={2}
                value={section.body}
                placeholder={tr('What should DigitalMate remember?', '希望 DigitalMate 记住什么？')}
                aria-label={tr('Section body', '分组内容')}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    sections: current.sections.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, body: event.target.value } : item
                    )
                  }))
                }
              />
              <input
                value={section.evidence ?? ''}
                placeholder={tr('Evidence or source (optional)', '证据或来源（可选）')}
                aria-label={tr('Evidence or source', '证据或来源')}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    sections: current.sections.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, evidence: event.target.value } : item
                    )
                  }))
                }
              />
            </div>
          ))}

          <div className="memory-actions">
            <button type="button" className="primary-action" onClick={save}>
              <Icon name="check" size={14} />
              {tr('Save memory', '保存记忆')}
            </button>
            <button type="button" className="ghost-action" onClick={() => setEditing(false)}>
              {tr('Cancel', '取消')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="memory-summary">{profile.summary}</p>
          {profile.tags.length ? (
            <div className="tag-row">
              {profile.tags.map(tag => (
                <span className="memory-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <div className="memory-sections">
            {profile.sections.map(section => (
              <article className="memory-section" key={section.title}>
                <h4>{section.title}</h4>
                <p>{section.body}</p>
                {section.evidence ? (
                  <span className="memory-evidence">
                    <Icon name="info" size={11} />
                    {section.evidence}
                  </span>
                ) : null}
              </article>
            ))}
          </div>
          <div className="memory-actions">
            <button type="button" className="secondary-action" onClick={startEdit}>
              <Icon name="edit" size={14} />
              {tr('Edit memory', '编辑记忆')}
            </button>
            <button type="button" className="secondary-action" onClick={() => importRef.current?.click()}>
              <Icon name="download" size={14} />
              {tr('Import profile', '导入画像')}
            </button>
            <button
              type="button"
              className="ghost-action"
              onClick={() => {
                if (window.confirm(tr('Forget all local memory?', '清除全部本地记忆？'))) {
                  onForget();
                }
              }}
            >
              <Icon name="trash" size={14} />
              {tr('Forget everything', '全部忘记')}
            </button>
          </div>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden-file-input memory-import-input"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importProfile(file);
            }}
          />
        </>
      )}

      <div className="sheet-footnote">
        <Icon name="lock" size={14} />
        {tr(
          'Memory stays in this browser and is included in Settings → Export backup. No account is used.',
          '记忆只保存在当前浏览器，并会包含在“设置 → 导出备份”中。无需账号。'
        )}
      </div>
    </Sheet>
  );
}

function taskStatusLabel(status: TaskRecord['status'], tr: (en: string, zh: string) => string): string {
  if (status === 'running') return tr('Running', '进行中');
  if (status === 'done') return tr('Done', '已完成');
  if (status === 'stopped') return tr('Stopped', '已停止');
  return tr('Error', '失败');
}

export function TaskShellSheet({
  tasks,
  onRetry,
  onClose,
  initialTaskId
}: {
  tasks: TaskRecord[];
  onRetry: (prompt: string) => void;
  onClose: () => void;
  initialTaskId?: string;
}) {
  const { tr, locale } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  const selected = tasks.find(task => task.id === selectedId);

  return (
    <Sheet
      title={tr('Sessions & tasks', '会话与任务')}
      subtitle={tr(`${tasks.length} local task rows · no account`, `${tasks.length} 条本地任务 · 无需账号`)}
      onClose={onClose}
      wide
    >
      {selected ? (
        <>
          <button type="button" className="ghost-action artifact-back" onClick={() => setSelectedId(null)}>
            <Icon name="back" size={14} />
            {tr('All tasks', '全部任务')}
          </button>
          <div className="task-detail-head">
            <span className={`task-status is-${selected.status}`}>{taskStatusLabel(selected.status, tr)}</span>
            <h3>{selected.title}</h3>
          </div>
          <p className="task-prompt">{selected.prompt}</p>
          <div className="info-rows">
            <div className="info-row">
              <span>{tr('Room', '房间')}</span>
              <strong>{selected.roomId}</strong>
            </div>
            <div className="info-row">
              <span>{tr('Skill', '技能')}</span>
              <strong>{selected.skill}</strong>
            </div>
            <div className="info-row">
              <span>{tr('Started', '开始时间')}</span>
              <strong>
                {new Date(selected.createdAt).toLocaleString(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </strong>
            </div>
            <div className="info-row">
              <span>{tr('Updated', '更新时间')}</span>
              <strong>
                {new Date(selected.updatedAt).toLocaleString(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </strong>
            </div>
          </div>
          {selected.status !== 'running' ? (
            <div className="detail-actions">
              <button type="button" className="secondary-action" onClick={() => onRetry(selected.prompt)}>
                <Icon name="refresh" size={14} />
                {tr('Retry task', '重试任务')}
              </button>
            </div>
          ) : null}
        </>
      ) : tasks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-orb">
            <Icon name="clock" size={26} />
          </div>
          <strong>{tr('No task rows yet', '还没有任务记录')}</strong>
          <p>{tr('Send a message to create a local task row.', '发送一条消息即可创建本地任务。')}</p>
        </div>
      ) : (
        <div className="task-list">
          {tasks.map(task => (
            <button type="button" className="task-row" key={task.id} onClick={() => setSelectedId(task.id)}>
              <span className={`task-dot is-${task.status}`} />
              <span className="task-copy">
                <strong>{task.title}</strong>
                <em>
                  {taskStatusLabel(task.status, tr)} · {task.roomId} ·{' '}
                  {new Date(task.updatedAt).toLocaleTimeString(locale, {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </em>
              </span>
              <Icon name="chevronRight" size={15} />
            </button>
          ))}
        </div>
      )}
      <div className="sheet-footnote">
        <Icon name="lock" size={14} />
        {tr(
          'Task rows are local records. No account, remote session or background job is created.',
          '任务记录仅保存在本地，不会创建账号、远程会话或后台任务。'
        )}
      </div>
    </Sheet>
  );
}

export function ArtifactsSheet({
  artifacts,
  onDelete,
  onClose,
  onNotice
}: {
  artifacts: Artifact[];
  onDelete: (id: string) => void;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const { tr, locale } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slidesMode, setSlidesMode] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const selected = artifacts.find(artifact => artifact.id === selectedId);
  const slides = selected ? artifactSlides(selected.content) : [];

  const download = (artifact: Artifact) => {
    const blob = new Blob([artifactDownloadContent(artifact)], {
      type: artifact.surface ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifactFilename(artifact);
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice(tr('Artifact downloaded.', '成果已下载。'));
  };

  return (
    <Sheet
      title={tr('Artifacts', '成果')}
      subtitle={tr(`${artifacts.length} saved locally · no account`, `${artifacts.length} 项本地成果 · 无需账号`)}
      onClose={onClose}
      wide
    >
      {selected ? (
        <>
          <button
            type="button"
            className="ghost-action artifact-back"
            onClick={() => {
              setSelectedId(null);
              setSlidesMode(false);
              setSlideIndex(0);
            }}
          >
            <Icon name="back" size={14} />
            {tr('All artifacts', '全部成果')}
          </button>
          <h3 className="artifact-title">{selected.title}</h3>
          <div className="artifact-meta">
            {new Date(selected.createdAt).toLocaleString(locale, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })}
            {' · '}
            {selected.kind}
          </div>
          {slides.length > 1 ? (
            <div className="artifact-view-toggle" role="group" aria-label={tr('Artifact view', '成果视图')}>
              <button
                type="button"
                aria-pressed={!slidesMode}
                className={!slidesMode ? 'is-active' : ''}
                onClick={() => setSlidesMode(false)}
              >
                {tr('Document', '文档')}
              </button>
              <button
                type="button"
                aria-pressed={slidesMode}
                className={slidesMode ? 'is-active' : ''}
                onClick={() => {
                  setSlidesMode(true);
                  setSlideIndex(0);
                }}
              >
                {tr('Slides', '幻灯片')}
              </button>
            </div>
          ) : null}
          {slidesMode && slides.length > 1 ? (
            <div className="artifact-slide">
              <span className="artifact-slide-count">
                {slideIndex + 1} / {slides.length}
              </span>
              <h4>{slides[slideIndex].title}</h4>
              <div className="artifact-slide-body">{renderMarkdown(slides[slideIndex].body)}</div>
              <div className="artifact-slide-nav">
                <button
                  type="button"
                  className="secondary-action"
                  disabled={slideIndex === 0}
                  onClick={() => setSlideIndex(index => Math.max(0, index - 1))}
                >
                  <Icon name="back" size={13} />
                  {tr('Previous', '上一页')}
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={slideIndex >= slides.length - 1}
                  onClick={() => setSlideIndex(index => Math.min(slides.length - 1, index + 1))}
                >
                  {tr('Next', '下一页')}
                  <Icon name="chevronRight" size={13} />
                </button>
              </div>
            </div>
          ) : (
            <>
              {selected.surface ? (
                <div className="artifact-surface">
                  <A2uiSurfaceView
                    surface={selected.surface}
                    onAction={() =>
                      onNotice(tr('Artifact actions are read-only.', '成果中的操作仅供查看。'))
                    }
                  />
                </div>
              ) : null}
              {selected.content ? <div className="artifact-preview">{renderMarkdown(selected.content)}</div> : null}
            </>
          )}
          <div className="detail-actions">
            <button type="button" className="secondary-action" onClick={() => download(selected)}>
              <Icon name="download" size={15} />
              {tr('Download', '下载')}
            </button>
            <button
              type="button"
              className="ghost-action"
              onClick={() => {
                if (window.confirm(tr('Delete this artifact?', '删除这个成果？'))) {
                  onDelete(selected.id);
                  setSelectedId(null);
                }
              }}
            >
              <Icon name="trash" size={15} />
              {tr('Delete', '删除')}
            </button>
          </div>
        </>
      ) : artifacts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-orb">
            <Icon name="grid" size={26} />
          </div>
          <strong>{tr('No artifacts yet', '还没有成果')}</strong>
          <p>
            {tr(
              'Save an assistant reply as an artifact to preview, export or keep it locally.',
              '把助手回复保存为成果，即可预览、导出或长期保留。'
            )}
          </p>
        </div>
      ) : (
        <div className="artifact-list">
          {artifacts.map(artifact => (
            <button
              type="button"
              className="artifact-row"
              key={artifact.id}
              onClick={() => {
                setSelectedId(artifact.id);
                setSlidesMode(false);
                setSlideIndex(0);
              }}
            >
              <span className="artifact-icon">
                <Icon name="grid" size={16} />
              </span>
              <span className="artifact-copy">
                <strong>{artifact.title}</strong>
                <em>
                  {new Date(artifact.createdAt).toLocaleString(locale, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}{' '}
                  · {artifact.kind}
                </em>
              </span>
              <Icon name="chevronRight" size={15} />
            </button>
          ))}
        </div>
      )}
      <div className="sheet-footnote">
        <Icon name="lock" size={14} />
        {tr(
          'Artifacts are stored in this browser and included in Settings → Export backup.',
          '成果保存在当前浏览器，并会包含在“设置 → 导出备份”中。'
        )}
      </div>
    </Sheet>
  );
}

export function DetailView({
  card,
  reaction,
  saved,
  related,
  onClose,
  onReact,
  onSave,
  onShare,
  onOpenRelated
}: {
  card: FeedCard;
  reaction: Reaction;
  saved: boolean;
  related: FeedCard[];
  onClose: () => void;
  onReact: (reaction: Reaction) => void;
  onSave: () => void;
  onShare: () => void;
  onOpenRelated: (card: FeedCard) => void;
}) {
  const { tr } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [card.id]);

  return (
    <div className="detail-layer" role="dialog" aria-modal="true" aria-label={card.title}>
      <header className="detail-header">
        <button type="button" className="icon-button" onClick={onClose} aria-label={tr('Back', '返回')}>
          <Icon name="back" size={20} />
        </button>
        <span>{card.sourceLabel}</span>
        <button
          type="button"
          className={`icon-button ${saved ? 'is-active' : ''}`}
          onClick={onSave}
          aria-label={tr('Save', '收藏')}
        >
          <Icon name="bookmark" size={19} filled={saved} />
        </button>
      </header>
      <div className="detail-scroll" ref={scrollRef} onScroll={event => {
        const element = event.currentTarget;
        const max = element.scrollHeight - element.clientHeight;
        setProgress(max > 0 ? Math.min(100, (element.scrollTop / max) * 100) : 100);
      }}>
        <div className="detail-progress" style={{ width: `${progress}%` }} />
        <div className="detail-cover" style={{ background: card.cover }}>
          <img
            className="detail-cover-image"
            src={coverForCard(card)}
            alt=""
            onError={event => {
              event.currentTarget.onerror = null;
              event.currentTarget.src = fallbackCoverForCard(card);
            }}
          />
          <span className="feed-source-badge">{card.sourceLabel}</span>
        </div>
        <div className="detail-body">
          <div className="feed-kicker">
            <span>{card.topic}</span>
            <span>·</span>
            <span>{card.readingTime}</span>
            <span>·</span>
            <span>{card.published}</span>
          </div>
          <h1>{card.title}</h1>
          <p className="detail-summary">{card.summary}</p>
          <div className="tag-row">
            {card.tags.map(tag => (
              <span className="mini-tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
          <div className="detail-content">
            {renderMarkdown(card.body.map(paragraph => paragraph).join('\n\n'))}
          </div>
          {card.images && card.images.length > 1 ? (
            <div className="detail-gallery">
              {card.images.map((image, index) => (
                <img
                  key={`${card.id}-image-${index}`}
                  src={image}
                  alt={tr(`Article image ${index + 1}`, `文章图片 ${index + 1}`)}
                  loading="lazy"
                />
              ))}
            </div>
          ) : null}
          {card.audioUrl ? (
            <div className="detail-media">
              <span className="detail-media-label">
                <Icon name="volume" size={14} />
                {tr('Audio from the feed', '来自订阅的音频')}
              </span>
              <audio className="detail-audio" controls preload="metadata" src={card.audioUrl} />
            </div>
          ) : null}
          {cardKind(card) === 'discussion' ? (
            <div className="detail-thread">
              <h3>{tr('Community replies', '社区回复')}</h3>
              <p className="settings-note">
                {tr(
                  'Local demo replies. Real discussions stay on the source platform.',
                  '本地演示回复。真实讨论仍在来源平台。'
                )}
              </p>
              <div className="thread-post">
                <span className="thread-avatar">A</span>
                <span>
                  <strong>Ada</strong>
                  <em>{tr('The failure-path section is the useful part.', '最有价值的是失败路径那一段。')}</em>
                </span>
              </div>
              <div className="thread-post">
                <span className="thread-avatar">K</span>
                <span>
                  <strong>Kai</strong>
                  <em>{tr('Saved this to compare with the local build.', '已收藏，准备和本地构建对比。')}</em>
                </span>
              </div>
            </div>
          ) : null}
          <div className="detail-source-note">
            <Icon name="info" size={15} />
            {tr(`Content from ${card.sourceLabel}. The demo keeps source labels and does not fetch private content behind a login.`, `内容来自 ${card.sourceLabel}。演示版保留来源标签，不抓取登录后的私密内容。`)}
          </div>
          <div className="detail-actions">
            <button
              type="button"
              className={`secondary-action ${reaction === 'like' ? 'is-on' : ''}`}
              onClick={() => onReact(reaction === 'like' ? undefined : 'like')}
            >
              <Icon name="thumbUp" size={16} filled={reaction === 'like'} />
              {tr('Like', '喜欢')}
            </button>
            <button type="button" className="secondary-action" onClick={onSave}>
              <Icon name="bookmark" size={16} filled={saved} />
              {saved ? tr('Saved', '已收藏') : tr('Save', '收藏')}
            </button>
            <button type="button" className="secondary-action" onClick={onShare}>
              <Icon name="share" size={16} />
              {tr('Share', '分享')}
            </button>
            <a className="primary-action" href={card.url} target="_blank" rel="noreferrer">
              {cardKind(card) === 'video'
                ? tr('Open video', '打开视频')
                : cardKind(card) === 'audio'
                  ? tr('Open episode', '打开音频')
                  : tr('Open original', '打开原文')}
              <Icon name="external" size={15} />
            </a>
          </div>

          {related.length > 0 ? (
            <div className="related-block">
              <h3>{tr('Related', '相关推荐')}</h3>
              {related.map(item => (
                <button type="button" className="related-row" key={item.id} onClick={() => onOpenRelated(item)}>
                  <span className="related-cover" style={{ background: item.cover }}>
                    {item.glyph}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <em>
                      {item.sourceLabel} · {item.readingTime}
                    </em>
                  </span>
                  <Icon name="chevronRight" size={15} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
