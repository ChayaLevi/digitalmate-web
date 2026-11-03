import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  A2uiAction,
  Artifact,
  Attachment,
  CalendarEvent,
  FeedCard,
  ItemDetail,
  RssFeed,
  Language,
  MemoryProfile,
  Message,
  Reaction,
  Settings,
  Skill,
  TaskRecord
} from './types';
import { newId, readStorage, writeStorage, clearDemoStorage, STORAGE_KEYS, usePersistentState } from './lib/storage';
import { MockChatTransport } from './transport/mock';
import { OrbitChatTransport, orbitHealth } from './transport/orbit';
import { Fridge2TableTransport, fridgeHealth, runFridgeAction, surfaceOfTurn } from './transport/fridge';
import { isKitchenIntent } from './lib/fridgeSurfaces';
import { LocalDiscoveryTransport, rotateCards } from './transport/discovery';
import type { ChatTransport } from './transport/types';
import { seedFor } from './data/seed';
import { surfacesFor } from './data/surfaces';
import { I18nContext } from './i18n/I18nContext';
import { HomeView } from './components/HomeView';
import { ChatView } from './components/ChatView';
import { DiscoveryView } from './components/DiscoveryView';
import { Composer } from './components/Composer';
import { DetailsSheet } from './components/DetailsSheet';
import { AttachmentSheet } from './components/AttachmentSheet';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { formatFileSize, readAttachment, releaseAttachment, summarizeAttachment, validateAttachment, MAX_ATTACHMENTS } from './lib/attachments';
import { mergeSkills } from './lib/skillBundle';
import { artifactFromText, findDuplicateArtifact } from './lib/artifacts';
import { nativeNotification, nativeShare, isNativeApp, configureNativeShell, consumeSharedText, onNativeNotificationTap, consumeLaunchTab } from './lib/native';
import { installDiagnostics } from './lib/diagnostics';
import { dedupeCards } from './lib/discoveryExperience';
import { DEFAULT_PERSONA, PERSONAS, DEFAULT_PROJECTS, personaById, personaName, personaSuggestions } from './data/personas';
import type { CapabilityOption, ModelOption, PersonaId, ProjectOption } from './data/personas';
import { CapabilitiesSheet, ModelSheet, PersonaSheet, ProjectSheet, modelLabel } from './components/ComposerSheets';
import { LabsSheet } from './components/LabsSheet';
import { WelcomeDeck } from './components/WelcomeDeck';
import { speakText, stopSpeaking } from './lib/voice';
import { App as CapacitorApp } from '@capacitor/app';
import { protocolDemoSurface } from './protocol/a2ui/demo';
import { CalendarEventSheet } from './components/CalendarEventSheet';
import { BrandMark, IconButton, StatusBar, TopBar } from './components/Chrome';
import { Icon } from './components/Icons';
import { BottomNav, DetailView, HistorySheet, MemorySheet, MoreSheet, SettingsSheet, SkillsSheet, ArtifactsSheet, TaskShellSheet, Toast } from './components/Overlays';

type Tab = 'chat' | 'discover';
type SheetName = 'history' | 'more' | 'skills' | 'settings' | 'memory' | 'artifacts' | 'tasks' | 'persona' | 'model' | 'project' | 'capabilities' | 'labs' | null;

const defaultSettings: Settings = {
  cloudBackend: 'local',
  notifications: true,
  reducedMotion: false,
  showThinking: true,
  speakReplies: false
};

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

function loadMessages(): Message[] {
  const stored = readStorage<Message[]>(STORAGE_KEYS.messages, []);
  return stored.map(message => ({
    ...message,
    streaming: false,
    thinking: message.thinking
      ? {
          ...message.thinking,
          done: true,
          steps: message.thinking.steps.map(step => ({ ...step, status: 'done' }))
        }
      : undefined
  }));
}

export default function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [home, setHome] = useState(true);
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [archived, setArchived] = usePersistentState<Message[]>(STORAGE_KEYS.archived, []);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [activeSkill, setActiveSkill] = useState('');
  const [activePersona, setActivePersona] = usePersistentState<PersonaId>(STORAGE_KEYS.persona, DEFAULT_PERSONA);
  const [personaNotes, setPersonaNotes] = usePersistentState<Record<string, string>>(STORAGE_KEYS.personaNotes, {});
  const [personaProfiles, setPersonaProfiles] = usePersistentState<
    Record<string, { soul?: string; skills?: string[] }>
  >(STORAGE_KEYS.personaProfiles, {});
  const [model, setModel] = usePersistentState<string>(STORAGE_KEYS.model, 'local-balanced');
  const [project, setProject] = usePersistentState<string>(STORAGE_KEYS.project, 'none');
  const [projects, setProjects] = usePersistentState<ProjectOption[]>(STORAGE_KEYS.projects, DEFAULT_PROJECTS);
  const [capabilities, setCapabilities] = usePersistentState<string[]>(STORAGE_KEYS.capabilities, [
    'local-search',
    'pdf-reader',
    'calendar'
  ]);
  const [deepSearch, setDeepSearch] = usePersistentState<boolean>(STORAGE_KEYS.deepSearch, false);
  const [welcomeSeen, setWelcomeSeen] = usePersistentState<boolean>(STORAGE_KEYS.welcomeSeen, false);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [taskFocus, setTaskFocus] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedCard | null>(null);
  const [detailItem, setDetailItem] = useState<ItemDetail | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [feedSeed, setFeedSeed] = useState(0);
  const [demoRunning, setDemoRunning] = useState(false);
  const demoRun = useRef(0);

  const [settings, setSettings] = usePersistentState<Settings>(STORAGE_KEYS.settings, defaultSettings);
  const [lang, setLang] = usePersistentState<Language>(STORAGE_KEYS.language, 'en');
  const tr = useCallback((english: string, chinese: string): string => (lang === 'zh' ? chinese : english), [lang]);
  const seed = seedFor(lang);
  const [reactions, setReactions] = usePersistentState<Record<string, Reaction>>(STORAGE_KEYS.reactions, {});
  const [topics, setTopics] = usePersistentState<string[]>(STORAGE_KEYS.topics, []);
  const [topicOrder, setTopicOrder] = usePersistentState<string[]>(STORAGE_KEYS.topicOrder, seed.topicOptions);
  const [hiddenTopics, setHiddenTopics] = usePersistentState<string[]>(STORAGE_KEYS.hiddenTopics, []);
  const [skills, setSkills] = usePersistentState<Skill[]>(STORAGE_KEYS.skills, seed.seedSkills);
  const [saved, setSaved] = usePersistentState<string[]>(STORAGE_KEYS.savedCards, []);
  const [rssCards, setRssCards] = usePersistentState<FeedCard[]>(STORAGE_KEYS.rssCards, []);
  const [readCards, setReadCards] = usePersistentState<string[]>(STORAGE_KEYS.readCards, []);
  const [enabledSources, setEnabledSources] = usePersistentState<string[]>(STORAGE_KEYS.enabledSources, []);
  const [calendarEvents, setCalendarEvents] = usePersistentState<CalendarEvent[]>(STORAGE_KEYS.calendarEvents, []);
  const [memory, setMemory] = usePersistentState<MemoryProfile>(STORAGE_KEYS.memoryProfile, seed.memoryProfile);
  const [artifacts, setArtifacts] = usePersistentState<Artifact[]>(STORAGE_KEYS.artifacts, []);
  const [tasks, setTasks] = usePersistentState<TaskRecord[]>(STORAGE_KEYS.tasks, []);

  const generation = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const activeTaskId = useRef<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLElement>(null);
  const nativeBackRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isNativeApp()) return;
    void configureNativeShell();
    const listener = CapacitorApp.addListener('backButton', () => nativeBackRef.current());
    return () => {
      void listener.then(handle => handle.remove());
    };
  }, []);

  useEffect(() => installDiagnostics(), []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  useEffect(() => {
    if (readStorage<boolean>(STORAGE_KEYS.topicMigration, false)) return;
    const legacyDefaults = [
      ['AI & Tech', 'HarmonyOS'],
      ['AI 科技', '鸿蒙开发']
    ];
    const isLegacyDefault = legacyDefaults.some(
      set => topics.length === set.length && set.every(topic => topics.includes(topic))
    );
    if (isLegacyDefault) setTopics([]);
    writeStorage(STORAGE_KEYS.topicMigration, true);
    // One-time migration from the old two-topic default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [tab, home]);

  const showToast = (message: string) => {
    if (!message) return;
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2800);
  };

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (text: string) => {
      if (cancelled || !text.trim()) return;
      setComposer(text.trim());
      setHome(false);
      setTab('chat');
      showToast(tr('Shared text added to the composer.', '已把分享内容放入输入框。'));
    };
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('text') || params.get('url') || '';
    if (shared) apply(shared);
    void consumeSharedText().then(apply);
    return () => {
      cancelled = true;
    };
    // Shared content is consumed once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => onNativeNotificationTap(() => setSheet('tasks')), []);

  useEffect(() => {
    if (!isNativeApp()) return;
    const apply = (tab: string) => {
      if (tab === 'discover') {
        setTab('discover');
        setHome(false);
      } else if (tab === 'chat') {
        setTab('chat');
        setHome(true);
      }
    };
    void consumeLaunchTab().then(apply);
    const listener = CapacitorApp.addListener('resume', () => {
      void consumeLaunchTab().then(apply);
    });
    return () => {
      void listener.then(handle => handle.remove());
    };
    // The native shell delivers a tab once per launch/resume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (messages.some(message => message.streaming)) return;
    const timer = window.setTimeout(() => writeStorage(STORAGE_KEYS.messages, messages), 220);
    return () => window.clearTimeout(timer);
  }, [messages]);

  const discoveryTransport = useMemo(
    () => new LocalDiscoveryTransport(seed.seedCards, rssCards, feedSeed),
    [feedSeed, rssCards, seed.seedCards]
  );
  const [allCards, setAllCards] = useState<FeedCard[]>(() =>
    dedupeCards(rotateCards([...rssCards, ...seed.seedCards], feedSeed))
  );

  useEffect(() => {
    let active = true;
    void discoveryTransport.load().then(cards => {
      if (active) setAllCards(dedupeCards(cards));
    });
    return () => {
      active = false;
    };
  }, [discoveryTransport]);

  const patchMessage = (id: string, patch: (message: Message) => Message) => {
    setMessages(previous => previous.map(message => (message.id === id ? patch(message) : message)));
  };

  const markRunningTasksStopped = () => {
    setTasks(previous =>
      previous.map(task =>
        task.status === 'running' ? { ...task, status: 'stopped', updatedAt: Date.now() } : task
      )
    );
    activeTaskId.current = null;
  };

  const notifyCompletion = async (body: string) => {
    if (!settings.notifications) return;
    const title = tr('DigitalMate task complete', 'DigitalMate 任务完成');
    try {
      if (await nativeNotification(title, body.slice(0, 140))) return;
    } catch {
      // Fall through to the browser notification.
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      new Notification(title, {
        body: body.slice(0, 140),
        tag: 'digitalmate-task'
      });
    } catch {
      // Notifications are optional; the in-app result is always available.
    }
  };

  const addFiles = async (fileList: File[] | FileList) => {
    const incoming = Array.from(fileList);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      showToast(tr(`You can attach up to ${MAX_ATTACHMENTS} files.`, `最多可添加 ${MAX_ATTACHMENTS} 个附件。`));
      return;
    }
    const valid: File[] = [];
    for (const file of incoming.slice(0, room)) {
      const error = validateAttachment(file);
      if (error) {
        showToast(tr(`Skipped ${error}.`, `已跳过 ${error}。`));
      } else {
        valid.push(file);
      }
    }
    if (valid.length === 0) return;
    const loaded = await Promise.all(valid.map(readAttachment));
    setAttachments(previous => [...previous, ...loaded].slice(0, MAX_ATTACHMENTS));
    showToast(
      tr(
        `Attached ${loaded.length} file${loaded.length === 1 ? '' : 's'} locally.`,
        `已在本地添加 ${loaded.length} 个附件。`
      )
    );
  };

  const removeAttachment = (index: number) => {
    setAttachments(previous => {
      const next = [...previous];
      const [removed] = next.splice(index, 1);
      if (removed) releaseAttachment(removed);
      return next;
    });
  };

  const moveAttachment = (from: number, direction: -1 | 1) => {
    setAttachments(previous => {
      const to = from + direction;
      if (to < 0 || to >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  // Fridge2Table keeps one chat session per DigitalMate chat (its own memory of the conversation).
  const fridgeSession = useRef(newId('dm'));

  const send = async (raw: string, options: { appendUser?: boolean; cookMode?: 'home' | 'shop' } = {}) => {
    const outgoing = attachments;
    const outgoingImages = outgoing
      .map(attachment => attachment.file)
      .filter((file): file is File => file instanceof File && file.type.startsWith('image/'));
    const prompt =
      raw.trim() ||
      (outgoing.length > 0
        ? activePersona === 'kitchen'
          ? tr('Here are photos of my kitchen', '这是我厨房的照片')
          : tr('Summarize the attachment', '总结附件')
        : '');
    if (!prompt) return;
    if (busy) {
      showToast(tr('Still generating — please wait.', '正在生成，请稍候。'));
      return;
    }

    const runId = generation.current;
    setHome(false);
    setTab('chat');
    setComposer('');
    setAttachments(current => {
      current.forEach(releaseAttachment);
      return [];
    });
    setBusy(true);

    const userMessage: Message = {
      id: newId('u'),
      role: 'user',
      text: prompt,
      createdAt: Date.now(),
      ...(outgoing.length > 0 ? { attachments: outgoing.map(summarizeAttachment) } : {})
    };
    const assistantId = newId('a');
    const taskId = newId('task');
    const taskStartedAt = Date.now();
    activeTaskId.current = taskId;
    setTasks(previous =>
      [
        {
          id: taskId,
          title: prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt,
          prompt,
          status: 'running' as const,
          createdAt: taskStartedAt,
          updatedAt: taskStartedAt,
          roomId: settings.cloudBackend === 'orbit' ? 'orbit' : 'local',
          skill: activeSkill || 'general',
          persona: activePersona
        },
        ...previous
      ].slice(0, 40)
    );
    const patchTask = (status: TaskRecord['status']) =>
      setTasks(previous =>
        previous.map(task =>
          task.id === taskId ? { ...task, status, updatedAt: Date.now() } : task
        )
      );
    const assistant: Message = {
      id: assistantId,
      role: 'assistant',
      text: '',
      createdAt: Date.now() + 1,
      streaming: true,
      thinking: {
        title: tr('Working', '处理中'),
        steps: [],
        done: false
      }
    };

    setMessages(previous =>
      options.appendUser === false
        ? [...previous, assistant]
        : [...previous, userMessage, assistant]
    );

    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;

    let transport: ChatTransport = new MockChatTransport(calendarEvents);
    const wantsKitchen = activePersona === 'kitchen' || isKitchenIntent(prompt);
    let kitchenRouted = false;
    if (wantsKitchen) {
      try {
        const health = await fridgeHealth(controller.signal);
        if (health.configured) {
          transport = new Fridge2TableTransport(fridgeSession.current);
          kitchenRouted = true;
        } else if (activePersona === 'kitchen') {
          showToast(
            tr(
              'Fridge2Table is not configured (FRIDGE2TABLE_URL); this turn uses the local mock.',
              '未配置 Fridge2Table（FRIDGE2TABLE_URL），本轮使用本地模拟。'
            )
          );
        }
      } catch {
        if (activePersona === 'kitchen') {
          showToast(tr('The Fridge2Table bridge is unreachable; this turn uses the local mock.', '无法连接 Fridge2Table 桥接，本轮使用本地模拟。'));
        }
      }
    }
    if (!kitchenRouted && settings.cloudBackend === 'orbit') {
      try {
        const health = await orbitHealth(controller.signal);
        if (health.configured) {
          transport = new OrbitChatTransport();
        } else {
          showToast(
            tr(
              'Orbit bridge is not configured; this turn uses the local mock.',
              'Orbit 桥接未配置，本轮使用本地模拟。'
            )
          );
        }
      } catch {
        showToast(
          tr(
            'Orbit bridge is unreachable; this turn uses the local mock.',
            '无法连接 Orbit 桥接，本轮使用本地模拟。'
          )
        );
      }
    }

    if (generation.current !== runId) return;

    let accumulated = '';

    try {
      await transport.send(
        {
          text: prompt,
          lang,
          submissionId: newId('sub'),
          persona: activePersona,
          model,
          capabilities,
          deepSearch,
          images: outgoingImages,
          cookMode: options.cookMode
        },
        event => {
          if (generation.current !== runId) return;
          switch (event.type) {
            case 'thinking': {
              const steps = event.steps.length > 0 ? event.steps : [event.step];
              patchMessage(assistantId, message => ({
                ...message,
                thinking: {
                  title: message.thinking?.title ?? tr('Working', '处理中'),
                  steps: steps.map((label, index) => ({
                    label,
                    status: index < event.index ? 'done' : index === event.index ? 'active' : 'pending'
                  })),
                  done: false
                }
              }));
              break;
            }
            case 'text':
              accumulated += event.text;
              patchMessage(assistantId, message => ({ ...message, text: accumulated }));
              break;
            case 'surface':
              patchMessage(assistantId, message => ({ ...message, surface: event.surface }));
              break;
            case 'followUps':
              patchMessage(assistantId, message => ({ ...message, followUps: event.followUps }));
              break;
            case 'error':
              accumulated = accumulated ? `${accumulated}\n\n${event.message}` : event.message;
              patchMessage(assistantId, message => ({ ...message, text: accumulated }));
              break;
            case 'done':
              break;
          }
        },
        controller.signal
      );
    } catch (error) {
      if (controller.signal.aborted || generation.current !== runId) return;
      const message = error instanceof Error ? error.message : 'Transport error';
      accumulated = accumulated ? `${accumulated}\n\n${message}` : message;
      patchMessage(assistantId, current => ({ ...current, text: accumulated }));
      patchTask('error');
    }

    if (generation.current !== runId) return;
    patchMessage(assistantId, message => ({
      ...message,
      text: message.text || accumulated,
      streaming: false,
      thinking: message.thinking
        ? { ...message.thinking, done: true, steps: message.thinking.steps.map(step => ({ ...step, status: 'done' })) }
        : undefined
    }));
    activeController.current = null;
    setBusy(false);
    patchTask('done');
    activeTaskId.current = null;
    void notifyCompletion(accumulated);
    if (settings.speakReplies) speakText(accumulated, lang);
  };

  const stop = () => {
    stopSpeaking();
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    if (activeTaskId.current) {
      setTasks(previous =>
        previous.map(task =>
          task.id === activeTaskId.current
            ? { ...task, status: 'stopped', updatedAt: Date.now() }
            : task
        )
      );
      activeTaskId.current = null;
    }
    setBusy(false);
    setMessages(previous =>
      previous.map(message =>
        message.streaming
          ? {
              ...message,
              streaming: false,
              thinking: message.thinking
                ? { ...message.thinking, done: true, steps: message.thinking.steps.map(step => ({ ...step, status: 'done' })) }
                : undefined
            }
          : message
      )
    );
    showToast(tr('Generation stopped.', '已停止生成。'));
  };

  const retryMessage = (id: string) => {
    const index = messages.findIndex(message => message.id === id);
    const previousUser = index > 0 ? messages[index - 1] : undefined;
    if (!previousUser || previousUser.role !== 'user') {
      showToast(tr('Cannot retry this message.', '无法重试这条消息。'));
      return;
    }
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    setMessages(current => current.filter(message => message.id !== id));
    setBusy(false);
    void send(previousUser.text, { appendUser: false });
  };

  const clearMessage = (id: string) => {
    const target = messages.find(message => message.id === id);
    if (!target) return;
    if (target.streaming) {
      generation.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      setBusy(false);
    }
    setMessages(current => {
      const index = current.findIndex(message => message.id === id);
      if (index === -1) return current;
      const next = [...current];
      if (next[index].role === 'assistant' && index > 0 && next[index - 1].role === 'user') {
        next.splice(index - 1, 2);
      } else if (next[index].role === 'user' && next[index + 1]?.role === 'assistant') {
        next.splice(index, 2);
      } else {
        next.splice(index, 1);
      }
      return next;
    });
    showToast(tr('Message cleared.', '消息已清除。'));
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(tr('Copied to the clipboard.', '已复制到剪贴板。'));
    } catch {
      showToast(tr('Clipboard access is not available.', '当前浏览器无法访问剪贴板。'));
    }
  };

  const shareText = async (text: string) => {
    try {
      if (await nativeShare('DigitalMate', text)) return;
    } catch {
      // Fall back to the web share sheet or clipboard.
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: 'DigitalMate', text });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    await copyText(text);
  };

  const saveArtifact = (messageId: string) => {
    const message = messages.find(item => item.id === messageId);
    if (!message || (!message.text.trim() && !message.surface)) {
      showToast(tr('This message has no content to save.', '这条消息没有可保存的内容。'));
      return;
    }
    const duplicate = message.text.trim()
      ? findDuplicateArtifact(artifacts, message.text)
      : artifacts.find(artifact => artifact.surface?.id === message.surface?.id);
    if (duplicate) {
      showToast(tr('This reply is already saved as an artifact.', '这条回复已保存为成果。'));
      return;
    }
    const artifact = artifactFromText(message.text, Date.now(), message.surface);
    if (!artifact) return;
    setArtifacts(previous => [artifact, ...previous]);
    showToast(tr('Saved as a local artifact.', '已保存为本地成果。'));
  };

  const newChat = () => {
    fridgeSession.current = newId('dm');
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    markRunningTasksStopped();
    setBusy(false);
    setArchived(previous => [...previous, ...messages]);
    setMessages([]);
    setComposer('');
    setAttachments([]);
    setHome(true);
    setTab('chat');
    setSheet(null);
    setDetailItem(null);
    setCalendarOpen(false);
    showToast(tr('Started a new chat.', '已开始新对话。'));
  };

  const resetDemo = () => {
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    clearDemoStorage();
    setMessages([]);
    setArchived([]);
    setSettings(defaultSettings);
    setReactions({});
    setTopics([]);
    setTopicOrder(seed.topicOptions);
    setHiddenTopics([]);
    setSkills(seed.seedSkills);
    setSaved([]);
    setRssCards([]);
    setCalendarEvents([]);
    setMemory(seed.memoryProfile);
    setArtifacts([]);
    setTasks([]);
    setBusy(false);
    setHome(true);
    setTab('chat');
    setSheet(null);
    setDetail(null);
    setDetailItem(null);
    setCalendarOpen(false);
    showToast(tr('Demo data cleared.', '演示数据已清除。'));
  };

  const changeLanguage = (next: Language) => {
    if (next === lang) return;
    const nextSeed = seedFor(next);
    setLang(next);
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    markRunningTasksStopped();
    setBusy(false);
    setMessages([]);
    setArchived([]);
    setRssCards([]);
    setCalendarEvents([]);
    setMemory(current =>
      JSON.stringify(current) === JSON.stringify(seed.memoryProfile) ? nextSeed.memoryProfile : current
    );
    setTopics([]);
    setTopicOrder(nextSeed.topicOptions);
    setHiddenTopics([]);
    setSkills(previous =>
      previous.map(skill => {
        const localized = nextSeed.seedSkills.find(item => item.id === skill.id);
        return localized ? { ...localized, installed: skill.installed, enabled: skill.enabled } : skill;
      })
    );
    setActiveSkill('');
    setHome(true);
    setTab('chat');
    setSheet(null);
    setDetail(null);
    setDetailItem(null);
    setCalendarOpen(false);
    showToast(next === 'zh' ? '已切换到中文。' : 'Switched to English.');
  };

  const addCalendarEvent = (event: CalendarEvent) => {    const next = [...calendarEvents, event];
    setCalendarEvents(next);
    setCalendarOpen(false);
    setHome(false);
    setTab('chat');
    const surface = surfacesFor(lang).calendarSurface(next);
    setMessages(previous => [
      ...previous,
      {
        id: newId('a'),
        role: 'assistant',
        text: tr(
          `Added **${event.title}** to the demo calendar. It is stored locally and is not synced to an account.`,
          `已把 **${event.title}** 添加到演示日历。日程只保存在本地，不会同步到账号。`
        ),
        createdAt: Date.now(),
        surface
      }
    ]);
    showToast(tr('Event added to the demo calendar.', '已添加到演示日历。'));
  };

  const stopDemo = () => {
    demoRun.current += 1;
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    setDemoRunning(false);
    setBusy(false);
    setSheet(null);
    showToast(tr('Guided demo stopped.', '已停止引导演示。'));
  };

  const startDemo = async () => {
    if (demoRunning) return;
    const run = ++demoRun.current;
    setDemoRunning(true);
    setSheet(null);
    setDetail(null);
    setDetailItem(null);
    setCalendarOpen(false);
    setHome(false);
    setTab('chat');
    setBusy(false);
    setMessages([]);
    setRssCards([]);
    setCalendarEvents([]);
    showToast(tr('Guided demo started.', '引导演示开始。'));

    await sleep(350);
    if (demoRun.current !== run) return;
    await send(tr('Find trains from Beijing to Shanghai tomorrow evening', '帮我查明天傍晚北京到上海的高铁'));
    if (demoRun.current !== run) return;
    await sleep(650);

    await send(tr('Show only trains', '只看高铁'));
    if (demoRun.current !== run) return;
    await sleep(650);

    await send(tr('What’s on my calendar tomorrow?', '帮我查看明天的日程'));
    if (demoRun.current !== run) return;
    await sleep(650);

    await send(tr('Find coffee shops near the Bantian Huawei campus in Shenzhen', '帮我搜索深圳坂田华为基地附近的咖啡店'));
    if (demoRun.current !== run) return;
    await sleep(900);

    setTab('discover');
    setTopics([seed.topicOptions[0], seed.topicOptions[4] ?? seed.topicOptions[0]]);
    showToast(tr('Discovery: topics adjusted.', '发现流：已调整主题。'));
    await sleep(2400);
    if (demoRun.current !== run) return;

    setTab('chat');
    setHome(true);
    setSheet('memory');
    await sleep(2600);
    if (demoRun.current !== run) return;

    setSheet(null);
    setDemoRunning(false);
    showToast(tr('Guided demo complete.', '引导演示完成。'));
  };

  const openProtocolDemo = () => {
    const surface = protocolDemoSurface(lang);
    setSheet(null);
    setHome(false);
    setTab('chat');
    if (!surface) {
      showToast(tr('Could not parse the protocol demo.', '无法解析协议演示。'));
      return;
    }
    setMessages(previous => [
      ...previous,
      {
        id: newId('a'),
        role: 'assistant',
        text: tr(
          'This surface came from **newline-delimited JSON envelopes** and was rendered with the same A2UI component catalog as the chat cards.',
          '这个界面来自 **换行分隔的 JSON 信封**，并使用与聊天卡片相同的 A2UI 组件目录渲染。'
        ),
        createdAt: Date.now(),
        surface
      }
    ]);
    showToast(tr('A2UI protocol demo rendered.', 'A2UI 协议演示已渲染。'));
  };

  const showFridgeAction = async (action: A2uiAction) => {
    if (busy) {
      showToast(tr('Still generating — please wait.', '正在生成，请稍候。'));
      return;
    }
    if (action.id === 'fridge.shop') {
      void send(String(action.args?.message ?? ''), { appendUser: false, cookMode: 'shop' });
      return;
    }
    setBusy(true);
    try {
      const turn = await runFridgeAction(action, lang);
      if (!turn) {
        showToast(tr(`Triggered: ${action.label}`, `已触发：${action.label}`));
        return;
      }
      const surface = surfaceOfTurn(turn);
      setMessages(previous => [
        ...previous,
        {
          id: newId('a'),
          role: 'assistant',
          text: turn.message,
          createdAt: Date.now(),
          ...(surface ? { surface } : {}),
          ...(turn.followUps.length ? { followUps: turn.followUps } : {})
        }
      ]);
      setHome(false);
      setTab('chat');
    } catch (error) {
      showToast(error instanceof Error ? error.message : tr('Fridge2Table action failed.', 'Fridge2Table 操作失败。'));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (action: A2uiAction) => {
    if (action.kind === 'fridge') {
      void showFridgeAction(action);
      return;
    }
    if (action.id === 'create') {
      setCalendarOpen(true);
      return;
    }
    if (action.prompt) {
      void send(action.prompt);
      return;
    }
    showToast(tr(`Triggered: ${action.label}`, `已触发：${action.label}`));
  };

  const forgetMemory = () => {
    setMemory({
      name: tr('You', '你'),
      headline: tr('Local profile', '本地画像'),
      summary: tr(
        'No long-term memory is stored yet. Add details whenever you want.',
        '还没有保存长期记忆。你可以随时补充。'
      ),
      tags: [],
      mbti: '—',
      sections: []
    });
    showToast(tr('Local memory cleared.', '本地记忆已清除。'));
  };

  const toggleTopic = (topic: string) => {
    setTopics(previous =>
      previous.includes(topic) ? previous.filter(item => item !== topic) : [...previous, topic]
    );
  };

  const applyTopics = (next: string[]) => {
    setTopics(next.length >= seed.topicOptions.length ? [] : Array.from(new Set(next)));
  };

  const moveTopic = (topic: string, direction: -1 | 1) => {
    setTopicOrder(previous => {
      const order = previous.length > 0 ? [...previous] : [...seed.topicOptions];
      const from = order.indexOf(topic);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return order;
      const [item] = order.splice(from, 1);
      order.splice(to, 0, item);
      return order;
    });
  };

  const toggleTopicVisibility = (topic: string) => {
    setHiddenTopics(previous =>
      previous.includes(topic) ? previous.filter(item => item !== topic) : [...previous, topic]
    );
  };

  const resetTopicOrder = () => {
    setTopicOrder(seed.topicOptions);
    setHiddenTopics([]);
  };

  const toggleSource = (source: string) => {
    const allSources = seed.discoverySources.map(item => item.id).filter(id => id !== 'all');
    setEnabledSources(previous => {
      const current = previous.length === 0 ? allSources : previous;
      const next = current.includes(source)
        ? current.filter(item => item !== source)
        : [...current, source];
      if (next.length === 0) {
        showToast(tr('Keep at least one source enabled.', '请至少保留一个来源。'));
        return current;
      }
      return next;
    });
  };

  const toggleCapability = (id: string) => {
    setCapabilities(previous =>
      previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]
    );
  };

  const react = (id: string, reaction: Reaction) => {
    setReactions(previous => {
      const next = { ...previous };
      if (reaction === undefined) delete next[id];
      else next[id] = reaction;
      return next;
    });
  };

  const toggleSave = (id: string) => {
    setSaved(previous => {
      if (previous.includes(id)) return previous.filter(item => item !== id);
      return [...previous, id];
    });
  };

  const addRss = (name: string, url: string, feed: RssFeed) => {
    const palette = [
      'linear-gradient(135deg, #f6e6c8 0%, #e8cd96 50%, #b28b4d 100%)',
      'linear-gradient(135deg, #e8f1e6 0%, #c9dfc6 50%, #7ea47c 100%)',
      'linear-gradient(135deg, #e9edf7 0%, #c7d3ea 50%, #7d8fb5 100%)',
      'linear-gradient(135deg, #f8e7e0 0%, #ecc8bb 50%, #b57f6b 100%)'
    ];
    const items = feed.items.slice(0, 5);
    const cards: FeedCard[] = items.map((item, index) => {
      const summary =
        item.summary ||
        tr('No summary was included in this feed item.', '该订阅条目没有提供摘要。');
      const words = summary.trim().split(/\s+/).length;
      const minutes = Math.max(1, Math.min(12, Math.round(words / 180) || 1));
      return {
        id: newId('rss'),
        source: 'rss',
        sourceLabel: tr('RSS', 'RSS'),
        topic: seed.topicOptions[index % seed.topicOptions.length],
        title: item.title,
        summary,
        glyph: item.title.slice(0, 1).toUpperCase(),
        cover: palette[index % palette.length],
        image: item.image,
        ...(item.images ? { images: item.images } : {}),
        kind: item.audio ? 'audio' : 'article',
        ...(item.audio ? { audioUrl: item.audio } : {}),
        readingTime: tr(`${minutes} min read`, `${minutes} 分钟阅读`),
        published: item.published || tr('From feed', '来自订阅'),
        url: item.link || url,
        body: [
          summary,
          tr(
            `Imported from ${feed.title} (${feed.format.toUpperCase()}) through the local RSS proxy.`,
            `通过本地 RSS 代理从 ${feed.title}（${feed.format.toUpperCase()}）导入。`
          ),
          tr(
            'The feed was fetched and parsed locally. Nothing is uploaded, and the original article opens on the publisher site.',
            '订阅在本地抓取和解析，不会上传内容；原文会在发布方网站打开。'
          )
        ],
        tags: Array.from(new Set(['RSS', name, feed.format.toUpperCase()])),
        metric: feed.title
      };
    });

    setRssCards(previous => [...cards, ...previous]);
    showToast(
      tr(
        `Imported ${cards.length} item${cards.length === 1 ? '' : 's'} from ${name}.`,
        `已从 ${name} 导入 ${cards.length} 条内容。`
      )
    );
  };

  const installedEnabled = skills.filter(skill => skill.installed && skill.enabled);
  const activePersonaDefinition = personaById(activePersona);
  const activePersonaName = personaName(activePersona, lang);
  const activeProject = projects.find(item => item.id === project) ?? projects[0];
  const activeSkillName = skills.find(skill => skill.id === activeSkill)?.name ?? tr('Default companion', '默认分身');
  const detailRelated = detail
    ? allCards.filter(card => card.id !== detail.id && (card.topic === detail.topic || card.source === detail.source)).slice(0, 2)
    : [];

  nativeBackRef.current = () => {
    if (sheet) {
      setSheet(null);
      return;
    }
    if (detail) {
      setDetail(null);
      return;
    }
    if (detailItem) {
      setDetailItem(null);
      return;
    }
    if (previewAttachment) {
      setPreviewAttachment(null);
      return;
    }
    if (calendarOpen) {
      setCalendarOpen(false);
      return;
    }
    if (!home) {
      setHome(true);
      return;
    }
    if (tab !== 'chat') {
      setTab('chat');
      setHome(true);
      return;
    }
    void CapacitorApp.exitApp();
  };

  return (
    <I18nContext.Provider value={{ lang, setLang: changeLanguage, tr, locale: lang === 'zh' ? 'zh-CN' : 'en-US' }}>
      <AppErrorBoundary tr={tr} onReset={resetDemo}>
      <div className={`stage ${settings.reducedMotion ? 'reduce-motion' : ''} ${isNativeApp() ? 'is-native' : ''}`}>
      <a className="skip-link" href="#main-content">
        {tr('Skip to main content', '跳到主要内容')}
      </a>
      {!welcomeSeen ? <WelcomeDeck onDone={() => setWelcomeSeen(true)} /> : null}
      {!online ? (
        <div className="offline-banner" role="status">
          <Icon name="wifi" size={13} />
          {tr('Offline · local mode still works', '离线 · 本地模式仍然可用')}
        </div>
      ) : null}
      <div className="stage-glow stage-glow-a" />
      <div className="stage-glow stage-glow-b" />
      <div className="app-frame" data-lang={lang}>
        <StatusBar />
        {tab === 'chat' ? (
          home ? (
            <TopBar
              left={
                <div className="brand">
                  <BrandMark />
                  <div>
                    <strong>DigitalMate</strong>
                    <span>{tr('Web demo', '网页演示')}</span>
                  </div>
                </div>
              }
              right={
                <>
                  <IconButton icon="heart" label={tr('About you', '关于你')} onClick={() => setSheet('memory')} />
                  <IconButton icon="clock" label={tr('History', '历史记录')} onClick={() => setSheet('history')} />
                  <IconButton icon="more" label={tr('More', '更多')} onClick={() => setSheet('more')} />
                </>
              }
            />
          ) : (
            <TopBar
              left={<IconButton icon="back" label={tr('Back to home', '返回首页')} onClick={() => setHome(true)} />}
              title={tr('Chat', '对话')}
              subtitle={
                busy
                  ? tr('Working on task', '正在执行任务')
                  : tr(`Local demo · ${activePersonaName}`, `本地演示 · ${activePersonaName}`)
              }
              right={
                <>
                  <IconButton icon="spark" label={tr('New chat', '新对话')} onClick={newChat} />
                  <IconButton icon="more" label={tr('More', '更多')} onClick={() => setSheet('more')} />
                </>
              }
            />
          )
        ) : (
          <TopBar
            left={
              <div className="brand">
                <BrandMark />
                <div>
                  <strong>{tr('Discover', '发现')}</strong>
                  <span>{tr('Multi-source feed · local ranking', '多源内容 · 本地排序')}</span>
                </div>
              </div>
            }
            right={
              <>
                <IconButton
                  icon="refresh"
                  label={tr('Refresh', '换一批')}
                  onClick={() => {
                    setFeedSeed(seed => seed + 3);
                    showToast(tr('Refreshed the local inventory.', '已从本地库存换一批内容。'));
                  }}
                />
                <IconButton icon="more" label={tr('More', '更多')} onClick={() => setSheet('more')} />
              </>
            }
          />
        )}

        <main id="main-content" tabIndex={-1} ref={contentRef} className={`screen-content ${tab === 'chat' && home ? 'is-home' : ''} ${tab === 'discover' ? 'is-discovery' : ''}`}>
          {tab === 'chat' ? (
            home ? (
              <HomeView
                messages={messages}
                reducedMotion={settings.reducedMotion}
                onSuggestion={prompt => void send(prompt)}
                onContinue={() => setHome(false)}
                onOpenSkills={() => setSheet('skills')}
                personaName={activePersonaName}
                personaAvatar={activePersonaDefinition.avatar}
                personaPrompts={personaSuggestions(activePersona, lang)}
                onOpenPersona={() => setSheet('persona')}
                recentTasks={tasks.slice(0, 3).map(task => ({ id: task.id, title: task.title, status: task.status }))}
                onOpenTasks={() => setSheet('tasks')}
                onResumeTask={id => {
                  setTaskFocus(id);
                  setSheet('tasks');
                }}
              />
            ) : (
              <ChatView
                messages={messages}
                showThinking={settings.showThinking}
                onAction={onAction}
                onDetails={setDetailItem}
                onFollowUp={prompt => void send(prompt)}
                onRetry={retryMessage}
                onClear={clearMessage}
                onCopy={text => void copyText(text)}
                onShare={text => void shareText(text)}
                onSaveArtifact={saveArtifact}
              />
            )
          ) : (
            <DiscoveryView
              cards={allCards}
              reactions={reactions}
              saved={saved}
              topics={topics}
              topicOrder={topicOrder}
              hiddenTopics={hiddenTopics}
              readCards={readCards}
              enabledSources={enabledSources}
              onToggleTopic={toggleTopic}
              onClearTopics={() => setTopics([])}
              onApplyTopics={applyTopics}
              onMoveTopic={moveTopic}
              onToggleTopicVisibility={toggleTopicVisibility}
              onResetTopicOrder={resetTopicOrder}
              onToggleSource={toggleSource}
              onReact={react}
              onSave={id => {
                toggleSave(id);
                showToast(saved.includes(id) ? tr('Removed from saved.', '已取消收藏。') : tr('Saved locally.', '已收藏到本地。'));
              }}
              onOpen={card => {
                setDetail(card);
                setReadCards(previous =>
                  previous.includes(card.id) ? previous : [...previous, card.id]
                );
              }}
              onRefresh={() => {
                setFeedSeed(seed => seed + 3);
                showToast(tr('Refreshed the local inventory.', '已从本地库存换一批内容。'));
              }}
              onAddRss={addRss}
              onNotice={showToast}
              filterCards={(cards, filters) => discoveryTransport.filter(cards, filters)}
            />
          )}
        </main>

        {tab === 'chat' ? (
          <div className="composer-area">
            <div className="composer-context">
              <button
                type="button"
                className="context-chip is-persona"
                onClick={() => setSheet('persona')}
                aria-label={tr(`Companion: ${activePersonaName}`, `分身：${activePersonaName}`)}
              >
                <span className="context-avatar" style={{ background: activePersonaDefinition.accent }}>
                  {activePersonaDefinition.avatar}
                </span>
                <span>{activePersonaName}</span>
              </button>
              <button type="button" className="context-chip" onClick={() => setSheet('model')}>
                <Icon name="spark" size={12} />
                <span>{modelLabel(model, lang)}</span>
              </button>
              <button type="button" className="context-chip" onClick={() => setSheet('project')}>
                <Icon name="grid" size={12} />
                <span>{activeProject.name}</span>
              </button>
              <button type="button" className="context-chip" onClick={() => setSheet('capabilities')}>
                <Icon name="plus" size={12} />
                <span>{tr(`${capabilities.length} tools`, `${capabilities.length} 个工具`)}</span>
              </button>
              <button
                type="button"
                className={`context-toggle ${deepSearch ? 'is-active' : ''}`}
                aria-pressed={deepSearch}
                onClick={() => {
                  setDeepSearch(!deepSearch);
                  showToast(
                    !deepSearch
                      ? tr('Deep search enabled for this task.', '已为本次任务开启深度搜索。')
                      : tr('Deep search disabled.', '已关闭深度搜索。')
                  );
                }}
              >
                <Icon name="search" size={12} />
                {tr('Deep', '深度')}
              </button>
            </div>
            <div className="skill-dock">
              <span className="skill-dock-label">
                <Icon name="spark" size={13} />
                {tr('Skills', '技能')}
              </span>
              <div className="skill-dock-scroll">
                {installedEnabled.slice(0, 3).map(skill => (
                  <button
                    type="button"
                    key={skill.id}
                    className={`skill-pill ${activeSkill === skill.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setActiveSkill(skill.id);
                      showToast(tr(`Using for this task: ${skill.name}`, `本次任务使用：${skill.name}`));
                    }}
                  >
                    <span>{skill.icon}</span>
                    {skill.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="skill-pill is-add"
                  onClick={() => setSheet('skills')}
                  aria-label={tr('Add skill', '添加技能')}
                  title={tr('Add skill', '添加技能')}
                >
                  <Icon name="plus" size={12} />
                </button>
              </div>
              <span className="skill-active">{activeSkillName}</span>
            </div>
            <Composer
              value={composer}
              onChange={setComposer}
              onSend={() => void send(composer)}
              onStop={stop}
              busy={busy}
              attachments={attachments}
              onAddFiles={files => void addFiles(files)}
              onPreviewAttachment={setPreviewAttachment}
              onRemoveAttachment={removeAttachment}
              onMoveAttachment={moveAttachment}
              onNotice={showToast}
            />
          </div>
        ) : null}

        <BottomNav
          tab={tab}
          onTab={next => {
            setTab(next);
            if (next === 'chat') setHome(true);
          }}
        />

        {demoRunning ? (
          <button type="button" className="demo-pill" onClick={stopDemo}>
            <span className="demo-pill-dot" />
            {tr('Stop demo', '停止演示')}
          </button>
        ) : null}

        <Toast message={toast} />

        {sheet === 'history' ? (
          <HistorySheet
            messages={[...archived, ...messages]}
            onClose={() => setSheet(null)}
            onSelect={() => {
              if (archived.length > 0 && messages.length === 0) {
                setMessages(archived);
                setArchived([]);
              }
              setSheet(null);
              setHome(false);
            }}
            onNewChat={newChat}
          />
        ) : null}
        {sheet === 'more' ? (
          <MoreSheet
            onClose={() => setSheet(null)}
            onSkills={() => setSheet('skills')}
            onMemory={() => setSheet('memory')}
            onHistory={() => setSheet('history')}
            onSettings={() => setSheet('settings')}
            onNewChat={newChat}
            onDemo={() => void startDemo()}
            onProtocol={openProtocolDemo}
            onArtifacts={() => setSheet('artifacts')}
            onTasks={() => {
              setTaskFocus(null);
              setSheet('tasks');
            }}
            onLabs={() => setSheet('labs')}
          />
        ) : null}
        {sheet === 'labs' ? <LabsSheet onClose={() => setSheet(null)} onNotice={showToast} /> : null}
        {sheet === 'skills' ? (
          <SkillsSheet
            skills={skills}
            onClose={() => setSheet(null)}
            onImport={imported => setSkills(previous => mergeSkills(previous, imported))}
            onToggle={id => {
              setSkills(previous =>
                previous.map(skill => {
                  if (skill.id !== id) return skill;
                  if (!skill.installed) return { ...skill, installed: true, enabled: true };
                  return { ...skill, enabled: !skill.enabled };
                })
              );
            }}
            onUninstall={id => {
              setSkills(previous =>
                previous.map(skill => (skill.id === id ? { ...skill, installed: false, enabled: false } : skill))
              );
              showToast(tr('Skill uninstalled.', '已卸载技能。'));
            }}
            onNotice={showToast}
          />
        ) : null}
        {sheet === 'settings' ? (
          <SettingsSheet
            settings={settings}
            onChange={setSettings}
            onClose={() => setSheet(null)}
            onReset={resetDemo}
            onNotice={showToast}
            onLanguageChange={changeLanguage}
            savedCount={saved.length}
            messageCount={messages.length + archived.length}
            onOpenPersona={() => setSheet('persona')}
            onOpenModel={() => setSheet('model')}
            onOpenProject={() => setSheet('project')}
            onOpenCapabilities={() => setSheet('capabilities')}
          />
        ) : null}
        {sheet === 'persona' ? (
          <PersonaSheet
            active={activePersona}
            notes={personaNotes[activePersona] ?? ''}
            soul={
              personaProfiles[activePersona]?.soul ??
              activePersonaDefinition.soul[lang === 'zh' ? 'zh' : 'en']
            }
            skills={
              personaProfiles[activePersona]?.skills ??
              activePersonaDefinition.skills[lang === 'zh' ? 'zh' : 'en']
            }
            onSoul={value =>
              setPersonaProfiles(previous => ({
                ...previous,
                [activePersona]: { ...previous[activePersona], soul: value }
              }))
            }
            onSkills={value =>
              setPersonaProfiles(previous => ({
                ...previous,
                [activePersona]: { ...previous[activePersona], skills: value }
              }))
            }
            onSelect={id => {
              setActivePersona(id);
              showToast(tr(`Companion: ${personaName(id, lang)}`, `已切换分身：${personaName(id, lang)}`));
            }}
            onNotes={notes =>
              setPersonaNotes(previous => ({ ...previous, [activePersona]: notes }))
            }
            onClose={() => setSheet(null)}
          />
        ) : null}
        {sheet === 'model' ? (
          <ModelSheet
            selected={model}
            onSelect={id => {
              setModel(id);
              showToast(tr(`Model: ${modelLabel(id, lang)}`, `模型：${modelLabel(id, lang)}`));
            }}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {sheet === 'project' ? (
          <ProjectSheet
            projects={projects}
            selected={project}
            onSelect={id => {
              setProject(id);
              const next = projects.find(item => item.id === id);
              showToast(tr(`Project: ${next?.name ?? id}`, `项目：${next?.name ?? id}`));
            }}
            onAdd={(name, path) => {
              const id = `project-${Date.now().toString(36)}`;
              setProjects(previous => [...previous, { id, name, path }]);
              setProject(id);
              showToast(tr(`Project added: ${name}`, `已添加项目：${name}`));
            }}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {sheet === 'capabilities' ? (
          <CapabilitiesSheet
            selected={capabilities}
            onToggle={toggleCapability}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {sheet === 'memory' ? (
          <MemorySheet
            profile={memory}
            personaName={activePersonaName}
            onSave={profile => {
              setMemory(profile);
              showToast(tr('Memory saved locally.', '记忆已保存到本地。'));
            }}
            onForget={forgetMemory}
            onClose={() => setSheet(null)}
            onNotice={showToast}
          />
        ) : null}

        {sheet === 'artifacts' ? (
          <ArtifactsSheet
            artifacts={artifacts}
            onDelete={id => {
              setArtifacts(previous => previous.filter(artifact => artifact.id !== id));
              showToast(tr('Artifact deleted.', '成果已删除。'));
            }}
            onClose={() => setSheet(null)}
            onNotice={showToast}
          />
        ) : null}

        {sheet === 'tasks' ? (
          <TaskShellSheet
            tasks={tasks}
            initialTaskId={taskFocus ?? undefined}
            onRetry={prompt => {
              setSheet(null);
              void send(prompt);
            }}
            onClose={() => setSheet(null)}
          />
        ) : null}

        {detail ? (
          <DetailView
            card={detail}
            reaction={reactions[detail.id]}
            saved={saved.includes(detail.id)}
            related={detailRelated}
            onClose={() => setDetail(null)}
            onReact={reaction => {
              react(detail.id, reaction);
              showToast(reaction === 'like' ? tr('Noted — I’ll show more like this.', '已记录喜欢，下次会多推荐类似内容。') : tr('Like removed.', '已取消喜欢。'));
            }}
            onSave={() => {
              toggleSave(detail.id);
              showToast(saved.includes(detail.id) ? tr('Removed from saved.', '已取消收藏。') : tr('Saved locally.', '已收藏到本地。'));
            }}
            onShare={() => void shareText(`${detail.title}\n\n${detail.summary}\n${detail.url}`)}
            onOpenRelated={setDetail}
          />
        ) : null}

        {detailItem ? (
          <DetailsSheet detail={detailItem} onClose={() => setDetailItem(null)} onNotice={showToast} />
        ) : null}

        {previewAttachment ? (
          <AttachmentSheet
            attachment={previewAttachment}
            onClose={() => setPreviewAttachment(null)}
            onNotice={showToast}
          />
        ) : null}

        {calendarOpen ? (
          <CalendarEventSheet onClose={() => setCalendarOpen(false)} onAdd={addCalendarEvent} />
        ) : null}
      </div>
      <div className="stage-caption">
        <span className="stage-caption-dot" />
        {tr('DigitalMate Web · mock-first companion', 'DigitalMate Web · 本地演示版')}
      </div>
      </div>
      </AppErrorBoundary>
    </I18nContext.Provider>
  );
}
