import { useMemo, useState } from 'react';
import { Icon } from './Icons';
import type { IconName } from './Icons';
import { Sheet } from './Overlays';
import { useI18n } from '../i18n/I18nContext';
import { EpicReplayView } from './EpicReplayView';

type LabId =
  | 'bim'
  | 'multitask'
  | 'deepsearch'
  | 'train'
  | 'foodmap'
  | 'ride'
  | 'checkout'
  | 'social'
  | 'payment'
  | 'epic';

interface LabItem {
  id: LabId;
  icon: IconName;
  title: { en: string; zh: string };
  subtitle: { en: string; zh: string };
}

const LABS: LabItem[] = [
  {
    id: 'epic',
    icon: 'spark',
    title: { en: 'Epic Replay', zh: 'Epic Replay 精彩回放' },
    subtitle: { en: 'Narrated slow-motion replays, driven by A2UI', zh: '由 A2UI 驱动的解说慢动作回放' }
  },
  {
    id: 'bim',
    icon: 'grid',
    title: { en: 'BIM dashboard', zh: 'BIM 仪表盘' },
    subtitle: { en: 'Local building metrics and zones', zh: '本地建筑指标与分区' }
  },
  {
    id: 'multitask',
    icon: 'spark',
    title: { en: 'Multi-task board', zh: '多任务面板' },
    subtitle: { en: 'Lanes, artifacts and retry', zh: '任务泳道、成果与重试' }
  },
  {
    id: 'deepsearch',
    icon: 'search',
    title: { en: 'Deep search', zh: '深度搜索' },
    subtitle: { en: 'Staged progress with sources', zh: '分阶段进度与来源' }
  },
  {
    id: 'train',
    icon: 'train',
    title: { en: 'Train presale', zh: '火车预售' },
    subtitle: { en: 'Non-transactional booking demo', zh: '不产生交易的预订演示' }
  },
  {
    id: 'foodmap',
    icon: 'coffee',
    title: { en: 'Food map', zh: '美食地图' },
    subtitle: { en: 'Local map with nearby pins', zh: '带附近标记的本地地图' }
  },
  {
    id: 'ride',
    icon: 'car',
    title: { en: 'Ride status', zh: '打车状态' },
    subtitle: { en: 'Mock driver route and ETA', zh: '模拟司机路线与预计到达' }
  },
  {
    id: 'checkout',
    icon: 'send',
    title: { en: 'Checkout review', zh: '结算预览' },
    subtitle: { en: 'Price review without payment', zh: '仅价格预览，不支付' }
  },
  {
    id: 'social',
    icon: 'chat',
    title: { en: 'Social hub', zh: '社交聚合' },
    subtitle: { en: 'Read-only posts from connected apps', zh: '来自已连接应用的只读消息' }
  },
  {
    id: 'payment',
    icon: 'shield',
    title: { en: 'Receiving account', zh: '收款账户' },
    subtitle: { en: 'Mock payout setup, no real account', zh: '模拟收款配置，无真实账户' }
  }
];

export function LabsSheet({
  onClose,
  onNotice
}: {
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const { lang, tr } = useI18n();
  const [active, setActive] = useState<LabId | null>(null);
  const item = active ? LABS.find(lab => lab.id === active) : null;
  const label = (value: { en: string; zh: string }) => value[lang === 'zh' ? 'zh' : 'en'];

  if (!item) {
    return (
      <Sheet
        title={tr('Labs', '实验室')}
        subtitle={tr('Local demos of screens from the original app', '原应用界面的本地演示')}
        onClose={onClose}
        wide
      >
        <div className="labs-grid">
          {LABS.map(lab => (
            <button type="button" className="lab-card" key={lab.id} onClick={() => setActive(lab.id)}>
              <span className="lab-icon">
                <Icon name={lab.icon} size={20} />
              </span>
              <strong>{label(lab.title)}</strong>
              <em>{label(lab.subtitle)}</em>
            </button>
          ))}
        </div>
        <p className="settings-note">
          {tr(
            'These screens use local sample data and never place orders or take payments. Epic Replay is the exception: it talks to your own Epic Replay server.',
            '这些界面使用本地示例数据，不会下单或支付。Epic Replay 除外：它会连接你自己的 Epic Replay 服务器。'
          )}
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={label(item.title)}
      subtitle={active === 'epic' ? tr('Uses your Epic Replay server', '使用你的 Epic Replay 服务器') : tr('Local demo · no side effects', '本地演示 · 无副作用')}
      onClose={onClose}
      wide
    >
      <button type="button" className="secondary-action lab-back" onClick={() => setActive(null)}>
        <Icon name="back" size={14} />
        {tr('All labs', '全部实验')}
      </button>
      {active === 'epic' ? <EpicReplayView onNotice={onNotice} /> : null}
      {active === 'bim' ? <BimDemo /> : null}
      {active === 'multitask' ? <MultiTaskDemo /> : null}
      {active === 'deepsearch' ? <DeepSearchDemo /> : null}
      {active === 'train' ? <TrainDemo onNotice={onNotice} /> : null}
      {active === 'foodmap' ? <FoodMapDemo onNotice={onNotice} /> : null}
      {active === 'ride' ? <RideDemo onNotice={onNotice} /> : null}
      {active === 'checkout' ? <CheckoutDemo onNotice={onNotice} /> : null}
      {active === 'social' ? <SocialDemo /> : null}
      {active === 'payment' ? <PaymentDemo onNotice={onNotice} /> : null}
    </Sheet>
  );
}

function BimDemo() {
  const { tr } = useI18n();
  return (
    <div className="lab-body">
      <div className="lab-stats">
        <div><em>{tr('Energy', '能耗')}</em><strong>82 kWh</strong><span>-6.2%</span></div>
        <div><em>{tr('Occupancy', '在室率')}</em><strong>64%</strong><span>+3.1%</span></div>
        <div><em>{tr('Open alerts', '待处理告警')}</em><strong>3</strong><span>{tr('1 high', '1 个高优先')}</span></div>
      </div>
      <div className="lab-table">
        <div className="lab-row is-head"><span>{tr('Zone', '区域')}</span><span>{tr('Temp', '温度')}</span><span>{tr('Status', '状态')}</span></div>
        <div className="lab-row"><span>A3 · Office</span><span>23.1°C</span><span className="is-ok">{tr('Normal', '正常')}</span></div>
        <div className="lab-row"><span>B1 · Workshop</span><span>26.8°C</span><span className="is-warn">{tr('Ventilate', '需要通风')}</span></div>
        <div className="lab-row"><span>C2 · Lobby</span><span>22.4°C</span><span className="is-ok">{tr('Normal', '正常')}</span></div>
      </div>
      <p className="settings-note">{tr('Sample BIM data for layout exploration only.', '仅用于布局探索的示例 BIM 数据。')}</p>
    </div>
  );
}

function MultiTaskDemo() {
  const { tr } = useI18n();
  const lanes = [
    { title: tr('Running', '进行中'), items: [tr('Summarize requirements', '总结需求'), tr('Compare train options', '比较车次')] },
    { title: tr('Needs review', '待确认'), items: [tr('Draft launch reply', '起草发布回复')] },
    { title: tr('Done', '已完成'), items: [tr('Find coffee nearby', '查找附近咖啡'), tr('Weekly brief', '每周简报')] }
  ];
  return (
    <div className="lab-body">
      <div className="task-lanes">
        {lanes.map(lane => (
          <div className="task-lane" key={lane.title}>
            <strong>{lane.title}</strong>
            {lane.items.map(task => (
              <button type="button" className="task-chip" key={task} onClick={() => undefined}>
                {task}
              </button>
            ))}
          </div>
        ))}
      </div>
      <p className="settings-note">{tr('Local board only; no background workers.', '仅本地面板，无后台任务。')}</p>
    </div>
  );
}

function DeepSearchDemo() {
  const { tr } = useI18n();
  const [stage, setStage] = useState(0);
  const stages = [
    tr('Plan queries', '规划查询'),
    tr('Search local and RSS', '搜索本地与 RSS'),
    tr('Deduplicate sources', '去重来源'),
    tr('Rank and summarize', '排序与总结')
  ];
  return (
    <div className="lab-body">
      <div className="deep-query">
        <Icon name="search" size={16} />
        <span>{tr('agent memory architecture', 'Agent 记忆架构')}</span>
      </div>
      <div className="deep-stages">
        {stages.map((label, index) => (
          <div className={`deep-stage ${index < stage ? 'is-done' : index === stage ? 'is-active' : ''}`} key={label}>
            <span className="deep-dot">{index < stage ? <Icon name="check" size={11} /> : index + 1}</span>
            {label}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="primary-action"
        onClick={() => setStage(value => (value >= stages.length ? 0 : value + 1))}
      >
        {stage >= stages.length ? tr('Reset', '重置') : tr('Advance stage', '推进阶段')}
      </button>
      <div className="source-mini-list">
        <span>{tr('arxiv.org', 'arxiv.org')}</span>
        <span>{tr('github.com', 'github.com')}</span>
        <span>{tr('local notes', '本地笔记')}</span>
      </div>
      <p className="settings-note">{tr('Mock progress only; no external search runs.', '仅模拟进度，不执行外部搜索。')}</p>
    </div>
  );
}

function TrainDemo({ onNotice }: { onNotice: (message: string) => void }) {
  const { tr } = useI18n();
  return (
    <div className="lab-body">
      <div className="train-options">
        <div className="train-option">
          <strong>G7 · 08:00 → 12:30</strong>
          <em>{tr('4h 30m · second class · ¥553', '4 小时 30 分 · 二等座 · ¥553')}</em>
        </div>
        <div className="train-option">
          <strong>G11 · 09:15 → 13:58</strong>
          <em>{tr('4h 43m · second class · ¥553', '4 小时 43 分 · 二等座 · ¥553')}</em>
        </div>
      </div>
      <button
        type="button"
        className="primary-action"
        onClick={() =>
          onNotice(
            tr('Demo only: no reservation was created and no payment was taken.', '仅演示：未创建预订，也未支付。')
          )
        }
      >
        {tr('Reserve (demo)', '预订（演示）')}
      </button>
      <p className="settings-note">{tr('Schedule is sample data.', '班次为示例数据。')}</p>
    </div>
  );
}

function FoodMapDemo({ onNotice }: { onNotice: (message: string) => void }) {
  const { tr } = useI18n();
  return (
    <div className="lab-body">
      <div className="map-demo" aria-hidden="true">
        <svg viewBox="0 0 320 180">
          <rect width="320" height="180" fill="#e9eee7" />
          <path d="M0 120 80 80 160 96 240 58 320 70" stroke="#c9d6c6" strokeWidth="10" fill="none" />
          <path d="M40 0 70 80 56 180M240 0l-8 60 18 120" stroke="#dce4da" strokeWidth="8" fill="none" />
          <circle cx="92" cy="96" r="7" fill="#b07a45" />
          <circle cx="164" cy="76" r="7" fill="#b07a45" />
          <circle cx="238" cy="112" r="7" fill="#b07a45" />
          <circle cx="164" cy="76" r="14" fill="none" stroke="#b07a45" strokeOpacity=".35" />
        </svg>
      </div>
      <div className="place-list">
        <button type="button" className="place-row" onClick={() => onNotice(tr('Demo place selected.', '已选择示例地点。'))}>
          <span><strong>Corner Coffee</strong><em>420 m · {tr('open', '营业中')}</em></span>
          <Icon name="chevronRight" size={14} />
        </button>
        <button type="button" className="place-row" onClick={() => onNotice(tr('Demo place selected.', '已选择示例地点。'))}>
          <span><strong>Tea Lab</strong><em>760 m · {tr('open', '营业中')}</em></span>
          <Icon name="chevronRight" size={14} />
        </button>
        <button type="button" className="place-row" onClick={() => onNotice(tr('Demo place selected.', '已选择示例地点。'))}>
          <span><strong>Noodle House</strong><em>1.1 km · {tr('closing soon', '即将打烊')}</em></span>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <p className="settings-note">{tr('Illustrative map, no map provider is called.', '示意地图，不调用地图服务。')}</p>
    </div>
  );
}

function RideDemo({ onNotice }: { onNotice: (message: string) => void }) {
  const { tr } = useI18n();
  return (
    <div className="lab-body">
      <div className="map-demo" aria-hidden="true">
        <svg viewBox="0 0 320 180">
          <rect width="320" height="180" fill="#e7edf2" />
          <path d="M20 150 90 120 140 128 210 70 300 40" stroke="#8ba7bf" strokeWidth="6" fill="none" strokeDasharray="10 8" />
          <circle cx="20" cy="150" r="7" fill="#5b7fa8" />
          <circle cx="300" cy="40" r="7" fill="#a05a72" />
          <circle cx="160" cy="108" r="9" fill="#fff" stroke="#5b7fa8" strokeWidth="3" />
        </svg>
      </div>
      <div className="ride-card">
        <div>
          <strong>{tr('Driver arriving in 3 min', '司机 3 分钟后到达')}</strong>
          <em>{tr('Silver sedan · 粤B · demo', '银色轿车 · 粤B · 演示')}</em>
        </div>
        <span>¥28</span>
      </div>
      <button type="button" className="secondary-action" onClick={() => onNotice(tr('Demo only: no ride was booked.', '仅演示：未叫车。'))}>
        {tr('Contact driver (demo)', '联系司机（演示）')}
      </button>
      <p className="settings-note">{tr('Mock route and fare.', '模拟路线与费用。')}</p>
    </div>
  );
}

function CheckoutDemo({ onNotice }: { onNotice: (message: string) => void }) {
  const { tr } = useI18n();
  const rows = useMemo(
    () => [
      [tr('Iced latte × 2', '冰拿铁 × 2'), '¥52'],
      [tr('Delivery', '配送费'), '¥6'],
      [tr('Discount', '优惠'), '-¥8']
    ],
    [tr]
  );
  return (
    <div className="lab-body">
      <div className="checkout-card">
        {rows.map(([label, value]) => (
          <div className="checkout-row" key={label}><span>{label}</span><strong>{value}</strong></div>
        ))}
        <div className="checkout-row is-total"><span>{tr('Total', '合计')}</span><strong>¥50</strong></div>
      </div>
      <button
        type="button"
        className="primary-action"
        onClick={() => onNotice(tr('Demo only: payment is not available.', '仅演示：不提供支付。'))}
      >
        {tr('Review payment (demo)', '确认支付（演示）')}
      </button>
      <p className="settings-note">{tr('No checkout, order or payment is created.', '不会创建结算、订单或支付。')}</p>
    </div>
  );
}

function SocialDemo() {
  const { tr } = useI18n();
  const posts = [
    { author: 'Ada', text: tr('The new build finally keeps the source label on every card.', '新版本终于让每张卡片都保留来源标签了。') },
    { author: 'Kai', text: tr('I like that the default feed is mixed instead of one topic.', '我喜欢默认信息流是混合的，而不是单一主题。') },
    { author: 'Mina', text: tr('Voice topic editing is the feature I use most.', '语音调整主题是我用得最多的功能。') }
  ];
  return (
    <div className="lab-body">
      {posts.map(post => (
        <div className="social-post" key={post.author}>
          <span className="thread-avatar">{post.author[0]}</span>
          <span><strong>{post.author}</strong><em>{post.text}</em></span>
        </div>
      ))}
      <p className="settings-note">{tr('Read-only local sample. No connected account.', '只读本地示例，未连接账号。')}</p>
    </div>
  );
}

function PaymentDemo({ onNotice }: { onNotice: (message: string) => void }) {
  const { tr } = useI18n();
  return (
    <div className="lab-body">
      <div className="payment-demo-card">
        <span className="connection-pill is-demo"><span className="connection-dot" />{tr('Demo account', '演示账户')}</span>
        <strong>{tr('Receiving account', '收款账户')}</strong>
        <em>{tr('Payouts are not enabled in this build.', '此版本未启用真实收款。')}</em>
        <div className="payment-demo-number">•••• •••• •••• 4242</div>
      </div>
      <button type="button" className="secondary-action" onClick={() => onNotice(tr('Demo only: no account was created.', '仅演示：未创建账户。'))}>
        {tr('Set up payouts (demo)', '设置收款（演示）')}
      </button>
    </div>
  );
}
