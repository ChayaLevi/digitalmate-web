export type ThinkingStatus = 'pending' | 'active' | 'done';

export type Language = 'en' | 'zh';

export interface ThinkingStep {
  label: string;
  status: ThinkingStatus;
}

export interface A2uiAction {
  id: string;
  label: string;
  prompt?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  kind?: string;
  /** Data the host needs to carry the action out (e.g. a Fridge2Table recipe id). */
  args?: Record<string, unknown>;
}

export interface A2uiMetric {
  label: string;
  value: string;
  tone?: string;
}

export interface A2uiComponent {
  id: string;
  component: string;
  child?: string;
  children?: string[];
  title?: string;
  text?: string;
  body?: string;
  status?: string;
  dataPath?: string;
  actions?: A2uiAction[];
  metrics?: A2uiMetric[];
  [key: string]: unknown;
}

export interface A2uiSurface {
  id: string;
  title?: string;
  subtitle?: string;
  status?: 'thinking' | 'ready' | 'error';
  root: string;
  components: Record<string, A2uiComponent>;
  data: Record<string, unknown>;
}

export interface AttachmentMeta {
  name: string;
  size: number;
  type: string;
  kind: 'text' | 'image' | 'pdf' | 'other';
}export interface Attachment extends AttachmentMeta {
  id: string;
  url?: string;
  text?: string;
  /** The original image, kept so it can be uploaded (Fridge2Table photos). Never persisted. */
  file?: File;
}

export interface Artifact {
  id: string;
  title: string;
  kind: 'markdown' | 'text' | 'json' | 'surface';
  content: string;
  surface?: A2uiSurface;
  createdAt: number;
}

export type TaskStatus = 'running' | 'done' | 'stopped' | 'error';

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  roomId: string;
  skill: string;
  persona?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  surface?: A2uiSurface;
  attachments?: AttachmentMeta[];
  thinking?: {
    title: string;
    steps: ThinkingStep[];
    done: boolean;
  };
  streaming?: boolean;
  followUps?: string[];
}

export interface FeedCard {
  id: string;
  source: string;
  sourceLabel: string;
  topic: string;
  title: string;
  summary: string;
  glyph: string;
  cover: string;
  image?: string;
  images?: string[];
  kind?: 'article' | 'video' | 'discussion' | 'audio';
  mediaUrl?: string;
  audioUrl?: string;
  readingTime: string;
  published: string;
  url: string;
  body: string[];
  tags: string[];
  metric: string;
}

export interface Skill {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  author: string;
  installed: boolean;
  enabled: boolean;
  builtin?: boolean;
  version?: string;
  capabilities?: string[];
}

export type Reaction = 'like' | 'dislike' | 'save' | undefined;

export interface Settings {
  cloudBackend: 'orbit' | 'local';
  notifications: boolean;
  reducedMotion: boolean;
  showThinking: boolean;
  speakReplies: boolean;
}

export interface ItemDetail {
  kind: 'train' | 'flight' | 'food';
  item: Record<string, unknown>;
}

export interface RssItem {
  title: string;
  link: string;
  summary: string;
  published?: string;
  author?: string;
  image?: string;
  images?: string[];
  audio?: string;
}

export interface RssFeed {
  title: string;
  description: string;
  link: string;
  format: 'rss' | 'atom' | 'rdf';
  items: RssItem[];
}

export interface CalendarEvent {
  id: string;
  time: string;
  title: string;
  meta: string;
  tone?: string;
}

export interface MemoryProfile {
  name: string;
  headline: string;
  summary: string;
  tags: string[];
  mbti: string;
  sections: { title: string; body: string; evidence?: string }[];
}
