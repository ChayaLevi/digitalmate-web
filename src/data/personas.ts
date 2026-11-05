import type { Language } from '../types';

export type PersonaId =
  | 'default'
  | 'food'
  | 'kitchen'
  | 'travel'
  | 'work'
  | 'entertainment'
  | 'game'
  | 'shopping'
  | 'family';

export interface PersonaDefinition {
  id: PersonaId;
  avatar: string;
  accent: string;
  name: { en: string; zh: string };
  tagline: { en: string; zh: string };
  soul: { en: string; zh: string };
  skills: { en: string[]; zh: string[] };
  suggestions: Array<{ en: string; zh: string }>;
}

export const PERSONAS: PersonaDefinition[] = [
  {
    id: 'default',
    avatar: '✦',
    accent: '#a06b58',
    name: { en: 'Default companion', zh: '默认分身' },
    tagline: { en: 'Everyday chat, summaries and unclassified tasks', zh: '日常闲聊、总结与无法归类的任务' },
    soul: {
      en: 'Calm and concise. I handle ordinary conversation, low-risk information work and tasks that do not clearly belong to another companion.',
      zh: '冷静、简洁。负责普通闲聊、低风险信息整理，以及暂时无法归类的任务。'
    },
    skills: { en: ['Explain', 'Summarise', 'Plan'], zh: ['解释', '总结', '规划'] },
    suggestions: [
      { en: 'Summarize this requirements document and list next steps', zh: '总结这份需求文档并列出下一步' },
      { en: 'Help me plan a focused afternoon', zh: '帮我安排一个专注的下午' },
      { en: 'Explain A2UI in simple terms', zh: '用简单的话解释 A2UI' }
    ]
  },
  {
    id: 'food',
    avatar: '☕',
    accent: '#b07a45',
    name: { en: 'Food companion', zh: '饮食搭子' },
    tagline: { en: 'Coffee, restaurants and nearby places', zh: '咖啡、餐厅与附近门店' },
    soul: {
      en: 'I understand taste, budget and distance, and I never invent store hours, prices or ratings.',
      zh: '理解口味、预算和距离，不编造营业状态、价格或评分。'
    },
    skills: { en: ['Nearby search', 'Compare menus', 'Diet notes'], zh: ['附近搜索', '菜单比较', '饮食偏好'] },
    suggestions: [
      { en: 'Find coffee shops near the Bantian Huawei campus', zh: '找坂田华为基地附近的咖啡店' },
      { en: 'Compare two milk tea options under 20 yuan', zh: '比较两款 20 元以内的奶茶' },
      { en: 'Suggest a quiet restaurant for a work lunch', zh: '推荐一家适合工作午餐的安静餐厅' }
    ]
  },
  {
    id: 'kitchen',
    avatar: '🥬',
    accent: '#3f7d55',
    name: { en: 'Kitchen companion', zh: '厨房搭子' },
    tagline: { en: 'What to cook from your fridge · Fridge2Table', zh: '用冰箱里的食材做什么 · Fridge2Table' },
    soul: {
      en: 'I know what is in your fridge, freezer and pantry. I suggest meals from what is there, check every suggestion with code, and never buy or delete anything without you.',
      zh: '我知道你冰箱、冷冻室和储物柜里有什么。我按现有食材推荐菜，每个建议都由代码核对；未经你同意，不会购买或删除任何东西。'
    },
    skills: { en: ['Fridge photos', 'Meal ideas', 'Shopping list'], zh: ['冰箱拍照', '菜品建议', '购物清单'] },
    suggestions: [
      { en: 'What can I cook tonight?', zh: '今晚我能做什么菜？' },
      { en: 'Something quick, under 20 minutes', zh: '来个 20 分钟以内的快手菜' },
      { en: 'What do I need for lasagna?', zh: '做千层面还缺什么？' },
      { en: 'Show my kitchen', zh: '看看我的厨房' }
    ]
  },
  {
    id: 'travel',
    avatar: '✈',
    accent: '#5b7fa8',
    name: { en: 'Travel companion', zh: '旅行搭子' },
    tagline: { en: 'Trains, flights, hotels and route planning', zh: '高铁、航班、酒店与路线规划' },
    soul: {
      en: 'I optimise for total time, transfers, budget and energy, and I state when live schedules or prices are unavailable.',
      zh: '关注总耗时、换乘、预算和体力；无法获取实时班次或价格时会明确说明。'
    },
    skills: { en: ['Train search', 'Flight search', 'Itinerary'], zh: ['火车查询', '航班查询', '行程规划'] },
    suggestions: [
      { en: 'Find trains from Beijing to Shanghai tomorrow', zh: '查明天北京到上海的高铁' },
      { en: 'Plan a two-day trip with low transfer stress', zh: '规划一个换乘压力小的两日行程' },
      { en: 'Compare train and flight for Friday evening', zh: '比较周五晚上的高铁和航班' }
    ]
  },
  {
    id: 'work',
    avatar: '▤',
    accent: '#5d7f73',
    name: { en: 'Work companion', zh: '工作分身' },
    tagline: { en: 'Mail, calendar and meeting preparation', zh: '邮件、日历与会议准备' },
    soul: {
      en: 'I am precise and low-noise. Drafts stay drafts until you confirm, and I separate facts from open questions.',
      zh: '准确、少打扰。草稿在确认前不会发送，并会区分事实与待确认项。'
    },
    skills: { en: ['Mail summary', 'Draft reply', 'Calendar'], zh: ['邮件摘要', '起草回复', '日历'] },
    suggestions: [
      { en: 'Summarize today’s important mail', zh: '总结今天的重要邮件' },
      { en: 'Draft a short reply to the launch thread', zh: '为发布讨论起草一段简短回复' },
      { en: 'Find a free hour for deep work tomorrow', zh: '明天找一个小时的深度工作时间' }
    ]
  },
  {
    id: 'entertainment',
    avatar: '▶',
    accent: '#a05a72',
    name: { en: 'Entertainment companion', zh: '娱乐搭子' },
    tagline: { en: 'Video, music, sport and evening wind-down', zh: '视频、音乐、体育与晚间放松' },
    soul: {
      en: 'I turn mood and available time into something playable or readable, without inventing schedules or scores.',
      zh: '把心情和可用时间变成可播放、可阅读的内容，不编造赛程或比分。'
    },
    skills: { en: ['Media search', 'Pick by mood', 'Shortlist'], zh: ['媒体搜索', '按心情推荐', '候选清单'] },
    suggestions: [
      { en: 'Find a 30-minute video for lunch', zh: '找一部适合午餐时看的 30 分钟视频' },
      { en: 'Recommend something light for tonight', zh: '推荐今晚轻松看的内容' },
      { en: 'Show public posts about the new film', zh: '看看关于这部新片的公开讨论' }
    ]
  },
  {
    id: 'game',
    avatar: '◈',
    accent: '#6b6fa8',
    name: { en: 'Game companion', zh: '游戏搭子' },
    tagline: { en: 'Game news, builds and strategy', zh: '游戏新闻、配装与攻略' },
    soul: {
      en: 'I ask for platform, progress and goal before giving advice, and I never fake live events or drop rates.',
      zh: '先确认平台、进度和目标，再给建议；不伪造实时活动或掉率。'
    },
    skills: { en: ['Patch notes', 'Build advice', 'Route plan'], zh: ['版本说明', '配装建议', '路线规划'] },
    suggestions: [
      { en: 'Explain this week’s balance changes', zh: '解释本周的平衡性调整' },
      { en: 'Suggest a beginner-friendly build', zh: '推荐一套新手友好的配装' },
      { en: 'Plan a short evening session', zh: '规划一个短时间的晚间游玩' }
    ]
  },
  {
    id: 'shopping',
    avatar: '◇',
    accent: '#8a6f45',
    name: { en: 'Shopping companion', zh: '购物搭子' },
    tagline: { en: 'Compare specs, prices and after-sales risk', zh: '比较参数、价格与售后风险' },
    soul: {
      en: 'I slow down impulse buys, compare hard requirements and warn about after-sales risk. I never order or pay.',
      zh: '帮你避免冲动消费，比较硬性需求并提示售后风险；从不下单或支付。'
    },
    skills: { en: ['Compare specs', 'Budget filter', 'Risk check'], zh: ['参数比较', '预算筛选', '风险检查'] },
    suggestions: [
      { en: 'Compare two earbuds under 500 yuan', zh: '比较两款 500 元以内的耳机' },
      { en: 'Check whether this laptop fits my budget', zh: '看看这台笔记本是否在预算内' },
      { en: 'List after-sales risks before I buy', zh: '购买前列出售后风险' }
    ]
  }
];

/**
 * The Family companion (Homemind). Not in `PERSONAS`: the app offers it only when the bridge says
 * Homemind is enabled (`HOMEMIND_ENABLED=1`), so without the flag the companion list is unchanged.
 */
export const FAMILY_PERSONA: PersonaDefinition = {
  id: 'family',
  avatar: '⌂',
  accent: '#7d6b9e',
  name: { en: 'Family companion', zh: '家庭搭子' },
  tagline: { en: 'One family board: who does what, and when · Homemind', zh: '一个家庭看板：谁做什么、什么时候 · Homemind' },
  soul: {
    en: 'I keep the family board: who owns each thing, who has not confirmed, and who is away. I never buy, order or send anything without a parent tapping for it.',
    zh: '我负责家庭看板：每件事由谁负责、谁还没确认、谁没空。未经家长逐项点按，我不会购买、下单或发送任何东西。'
  },
  skills: { en: ['Family board', 'Ownership', 'Availability'], zh: ['家庭看板', '分工', '谁有空'] },
  suggestions: [
    { en: "What's on for the family today?", zh: '今天家里有什么安排？' },
    { en: 'Who is picking up Noa?', zh: '谁去接诺娅？' }
  ]
};

export const DEFAULT_PERSONA: PersonaId = 'default';

export function personaById(id: PersonaId): PersonaDefinition {
  if (id === 'family') return FAMILY_PERSONA;
  return PERSONAS.find(persona => persona.id === id) ?? PERSONAS[0];
}

export function personaName(id: PersonaId, lang: Language): string {
  const persona = personaById(id);
  return persona.name[lang === 'zh' ? 'zh' : 'en'];
}

export function personaSuggestions(id: PersonaId, lang: Language): string[] {
  return personaById(id).suggestions.map(item => item[lang === 'zh' ? 'zh' : 'en']);
}

export interface ModelOption {
  id: string;
  name: { en: string; zh: string };
  detail: { en: string; zh: string };
}

export const MODELS: ModelOption[] = [
  {
    id: 'local-fast',
    name: { en: 'Local · Fast', zh: '本地 · 快速' },
    detail: { en: 'Short mock replies, no network', zh: '简短模拟回复，不联网' }
  },
  {
    id: 'local-balanced',
    name: { en: 'Local · Balanced', zh: '本地 · 均衡' },
    detail: { en: 'Default demo model', zh: '默认演示模型' }
  },
  {
    id: 'local-deep',
    name: { en: 'Local · Deep', zh: '本地 · 深度' },
    detail: { en: 'Longer traces and richer cards', zh: '更长的执行轨迹与更丰富的卡片' }
  },
  {
    id: 'orbit',
    name: { en: 'Orbit bridge', zh: 'Orbit 桥接' },
    detail: { en: 'Requires a configured bridge', zh: '需要已配置的桥接服务' }
  }
];

export interface ProjectOption {
  id: string;
  name: string;
  path: string;
}

export const DEFAULT_PROJECTS: ProjectOption[] = [
  { id: 'none', name: 'No project', path: '' },
  { id: 'digitalmate-web', name: 'DigitalMate Web', path: '~/projects/digitalmate-web' },
  { id: 'design-notes', name: 'Design notes', path: '~/Documents/design-notes' }
];

export interface CapabilityOption {
  id: string;
  name: { en: string; zh: string };
  detail: { en: string; zh: string };
  local: boolean;
}

export const CAPABILITIES: CapabilityOption[] = [
  {
    id: 'local-search',
    name: { en: 'Local discovery search', zh: '本地发现搜索' },
    detail: { en: 'Search seeded and RSS inventory', zh: '搜索种子与 RSS 内容' },
    local: true
  },
  {
    id: 'pdf-reader',
    name: { en: 'PDF text extraction', zh: 'PDF 文本提取' },
    detail: { en: 'On-device parsing', zh: '端侧解析' },
    local: true
  },
  {
    id: 'calendar',
    name: { en: 'Local calendar', zh: '本地日历' },
    detail: { en: 'Create local events', zh: '创建本地日程' },
    local: true
  },
  {
    id: 'mcp-weather',
    name: { en: 'Weather MCP', zh: '天气 MCP' },
    detail: { en: 'Demo only until a bridge is configured', zh: '未配置桥接时为演示' },
    local: false
  },
  {
    id: 'mcp-maps',
    name: { en: 'Places / maps MCP', zh: '地点 / 地图 MCP' },
    detail: { en: 'Demo only until a bridge is configured', zh: '未配置桥接时为演示' },
    local: false
  }
];
