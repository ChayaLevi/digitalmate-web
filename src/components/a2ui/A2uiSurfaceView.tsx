import type { ReactNode } from 'react';
import type { A2uiAction, A2uiComponent, A2uiSurface, ItemDetail } from '../../types';
import { renderMarkdown } from '../../lib/markdown';
import { Icon } from '../Icons';
import { useI18n } from '../../i18n/I18nContext';
import { renderEpicComponent } from './epicComponents';

interface SurfaceProps {
  surface: A2uiSurface;
  onAction: (action: A2uiAction) => void;
  onDetails?: (detail: ItemDetail) => void;
  /** Input values for data-bearing components (Epic Replay). Optional: other surfaces ignore it. */
  form?: Record<string, unknown>;
  onInput?: (name: string, value: unknown) => void;
}

function resolvePath(data: unknown, path?: string): unknown {
  if (!path || path === '/') return data;
  return path
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current)) return current[Number(segment)];
      if (typeof current === 'object') return (current as Record<string, unknown>)[segment];
      return undefined;
    }, data);
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function statusLabel(status: string, tr: (en: string, zh: string) => string): string {
  if (status === 'ready') return tr('Ready', '已就绪');
  if (status === 'error') return tr('Error', '失败');
  if (status === 'thinking') return tr('Working', '处理中');
  return status;
}

function toneClass(tone?: string): string {
  switch (tone) {
    case 'success':
      return 'tone-success';
    case 'warning':
      return 'tone-warning';
    case 'danger':
      return 'tone-danger';
    case 'accent':
      return 'tone-accent';
    case 'train':
      return 'tone-train';
    case 'flight':
      return 'tone-flight';
    default:
      return 'tone-muted';
  }
}

function chartColor(tone?: string): string {
  switch (tone) {
    case 'success':
      return '#3f7d55';
    case 'warning':
      return '#9a7027';
    case 'danger':
      return '#a84c42';
    case 'train':
      return '#4f8a66';
    case 'flight':
      return '#4a5f96';
    case 'accent':
      return '#995f4c';
    default:
      return '#b9ada3';
  }
}

interface RenderContext {
  surface: A2uiSurface;
  onAction: (action: A2uiAction) => void;
  onDetails?: (detail: ItemDetail) => void;
  form?: Record<string, unknown>;
  onInput?: (name: string, value: unknown) => void;
  tr: (en: string, zh: string) => string;
}

function actionButton(action: A2uiAction, ctx: RenderContext, key: string): ReactNode {
  return (
    <button
      key={key}
      type="button"
      className={`a2ui-button ${action.variant === 'primary' ? 'is-primary' : action.variant === 'ghost' ? 'is-ghost' : 'is-secondary'}`}
      onClick={() => ctx.onAction(action)}
    >
      {action.label}
      {action.variant === 'primary' ? <Icon name="chevronRight" size={14} /> : null}
    </button>
  );
}

function renderComponent(component: A2uiComponent, ctx: RenderContext, key: string): ReactNode {
  const { surface, tr } = ctx;
  const children = component.children ?? (component.child ? [component.child] : []);

  switch (component.component) {
    case 'SurfaceRoot':
      return (
        <section className="a2ui-surface" key={key} aria-label={component.title ?? surface.title}>
          <header className="surface-head">
            <div>
              <div className="surface-kicker">
                <span className="surface-dot" />
                A2UI · {surface.status === 'error' ? tr('Error', '错误') : tr('Ready', '已就绪')}
              </div>
              <h3>{component.title ?? surface.title}</h3>
              {surface.subtitle ? <p>{surface.subtitle}</p> : null}
            </div>
            {component.status ? <span className="surface-status">{statusLabel(component.status, tr)}</span> : null}
          </header>
          <div className="surface-body">
            {children.map((childId, index) => {
              const child = surface.components[childId];
              return child ? renderComponent(child, ctx, `${key}-${childId}-${index}`) : null;
            })}
          </div>
        </section>
      );

    case 'Column':
      return (
        <div className="a2ui-col" key={key}>
          {children.map((childId, index) => {
            const child = surface.components[childId];
            return child ? renderComponent(child, ctx, `${key}-${childId}-${index}`) : null;
          })}
        </div>
      );

    case 'Row':
      return (
        <div className="a2ui-row" key={key}>
          {children.map((childId, index) => {
            const child = surface.components[childId];
            return child ? renderComponent(child, ctx, `${key}-${childId}-${index}`) : null;
          })}
        </div>
      );

    case 'Text': {
      const value = component.text ?? component.body ?? textOf(resolvePath(surface.data, component.dataPath));
      return (
        <div className="a2ui-text" key={key}>
          {renderMarkdown(value)}
        </div>
      );
    }

    case 'InfoRows': {
      const rows = (resolvePath(surface.data, component.dataPath) ?? component.children ?? []) as Array<Record<string, string>>;
      return (
        <div className="info-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="info-rows">
            {rows.map((row, index) => (
              <div className="info-row" key={`${key}-row-${index}`}>
                <span>{row.label}</span>
                <strong className={toneClass(row.tone)}>{row.value}</strong>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'ActionBar':
      return (
        <div className="a2ui-actions" key={key}>
          {(component.actions ?? []).map((action, index) => actionButton(action, ctx, `${key}-action-${index}`))}
        </div>
      );

    case 'ErrorNotice':
      return (
        <div className="a2ui-error" key={key}>
          <Icon name="info" size={18} />
          <div>
            <strong>{component.title ?? tr('Unable to complete', '暂时无法完成')}</strong>
            <p>{component.body ?? component.text ?? tr('The source did not return a usable result.', '来源没有返回可用结果。')}</p>
          </div>
        </div>
      );

    case 'TravelOptions': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="travel-list">
            {items.map((item, index) => {
              const isTrain = item.kind === 'train';
              return (
                <article
                  className={`travel-card ${isTrain ? 'is-train' : 'is-flight'} is-clickable`}
                  key={`${key}-travel-${index}`}
                  onClick={() => ctx.onDetails?.({ kind: isTrain ? 'train' : 'flight', item })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      ctx.onDetails?.({ kind: isTrain ? 'train' : 'flight', item });
                    }
                  }}
                >
                  <div className="travel-top">
                    <span className={`kind-pill ${isTrain ? 'is-train' : 'is-flight'}`}>
                      <Icon name={isTrain ? 'train' : 'plane'} size={15} />
                      {isTrain ? tr('Train', '高铁') : tr('Flight', '飞机')}
                    </span>
                    <span className="travel-code">{item.code}</span>
                    <span className="travel-price">{item.price}</span>
                  </div>
                  <div className="travel-route">
                    <div>
                      <strong>{item.depart}</strong>
                      <span>{item.from}</span>
                    </div>
                    <div className="travel-line">
                      <span>{item.duration}</span>
                      <i />
                    </div>
                    <div>
                      <strong>{item.arrive}</strong>
                      <span>{item.to}</span>
                    </div>
                  </div>
                  <div className="travel-bottom">
                    <span className="travel-seats">{item.seats}</span>
                    <span className="source-tag">{item.sourceTag}</span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={event => {
                        event.stopPropagation();
                        if (ctx.onDetails) {
                          ctx.onDetails({ kind: isTrain ? 'train' : 'flight', item });
                        } else {
                          ctx.onAction({ id: `view-${item.code ?? index}`, label: 'Details' });
                        }
                      }}
                    >
                      {tr('View', '查看')}
                      <Icon name="chevronRight" size={13} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      );
    }

    case 'TrainOptions': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="travel-list">
            {items.map((item, index) => (
              <article
                className="travel-card is-train is-clickable"
                key={`${key}-train-${index}`}
                onClick={() => ctx.onDetails?.({ kind: 'train', item })}
                role="button"
                tabIndex={0}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') ctx.onDetails?.({ kind: 'train', item });
                }}
              >
                <div className="travel-top">
                  <span className="kind-pill is-train">
                    <Icon name="train" size={15} />
                    {tr('Train', '高铁')}
                  </span>
                  <span className="travel-code">{item.trainCode}</span>
                  <span className="travel-price">{item.price}</span>
                </div>
                <div className="travel-route">
                  <div>
                    <strong>{item.depart}</strong>
                    <span>{item.from}</span>
                  </div>
                  <div className="travel-line">
                    <span>{item.duration}</span>
                    <i />
                  </div>
                  <div>
                    <strong>{item.arrive}</strong>
                    <span>{item.to}</span>
                  </div>
                </div>
                <div className="travel-bottom">
                  <span className="travel-seats">{item.seats}</span>
                  <span className="source-tag">{item.sourceTag}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      );
    }

    case 'FoodChoices': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="food-list">
            {items.map((item, index) => {
              const tags = (item.sourceTags as string[]) ?? [];
              return (
                <article
                  className="food-card is-clickable"
                  key={`${key}-food-${index}`}
                  onClick={() => ctx.onDetails?.({ kind: 'food', item })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') ctx.onDetails?.({ kind: 'food', item });
                  }}
                >
                  <div className="food-mark">
                    <Icon name="coffee" size={20} />
                  </div>
                  <div className="food-main">
                    <div className="food-title-line">
                      <h4>{textOf(item.name)}</h4>
                      <span className="food-price">{textOf(item.price)}</span>
                    </div>
                    <div className="food-meta">
                      <span>{textOf(item.category)}</span>
                      <span>·</span>
                      <span>{textOf(item.distance)}</span>
                      <span>·</span>
                      <span>{textOf(item.rating)} ★</span>
                      <span className="open-pill">{textOf(item.open)}</span>
                    </div>
                    <div className="food-address">{textOf(item.address)}</div>
                    <div className="tag-row">
                      {tags.map(tag => (
                        <span className="mini-tag" key={`${key}-${index}-${tag}`}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      );
    }

    case 'SocialHub': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="social-list">
            {items.map((item, index) => (
              <article className={`social-card ${item.unread ? 'is-unread' : ''}`} key={`${key}-social-${index}`}>
                <div className="social-avatar">{textOf(item.author).slice(0, 1)}</div>
                <div className="social-body">
                  <div className="social-head">
                    <strong>{textOf(item.author)}</strong>
                    <span>{textOf(item.handle)}</span>
                    <span className="social-channel">{textOf(item.channel)}</span>
                    <time>{textOf(item.time)}</time>
                  </div>
                  <p>{textOf(item.text)}</p>
                </div>
                {item.unread ? <span className="unread-dot" /> : null}
              </article>
            ))}
          </div>
        </div>
      );
    }

    case 'ConfirmPanel':
      return (
        <div className="confirm-panel" key={key}>
          <div className="confirm-icon">
            <Icon name="shield" size={18} />
          </div>
          <div className="confirm-main">
            <strong>{component.title ?? tr('Needs confirmation', '需要确认')}</strong>
            <p>{component.body ?? component.text}</p>
            {component.actions?.length ? (
              <div className="a2ui-actions">
                {component.actions.map((action, index) => actionButton(action, ctx, `${key}-confirm-${index}`))}
              </div>
            ) : null}
          </div>
        </div>
      );

    case 'GenericToolResults': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="generic-list">
            {items.map((item, index) => (
              <article className="generic-row" key={`${key}-generic-${index}`}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                </div>
                <div className="generic-meta">
                  <span>{item.meta}</span>
                  {item.status ? <em>{item.status}</em> : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      );
    }

    case 'MetricGrid': {
      const items = (resolvePath(surface.data, component.dataPath) ?? component.metrics ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="metric-grid">
            {items.map((item, index) => (
              <div className="metric-card" key={`${key}-metric-${index}`}>
                <span>{item.label}</span>
                <strong className={toneClass(item.tone)}>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'ScheduleStack': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="schedule-list">
            {items.map((item, index) => (
              <div className="schedule-row" key={`${key}-schedule-${index}`}>
                <time>{item.time}</time>
                <span className={`schedule-line ${toneClass(item.tone)}`} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.meta}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'HotelOptions': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="hotel-list">
            {items.map((item, index) => {
              const tags = (item.tags as string[]) ?? [];
              return (
                <article className="hotel-card" key={`${key}-hotel-${index}`}>
                  <div className="hotel-mark">
                    <Icon name="hotel" size={17} />
                  </div>
                  <div className="hotel-main">
                    <div className="hotel-title-line">
                      <strong>{textOf(item.name)}</strong>
                      <span className="hotel-price">{textOf(item.price)}</span>
                    </div>
                    <div className="hotel-meta">
                      <span>{textOf(item.area)}</span>
                      <span>·</span>
                      <span>{textOf(item.rating)} ★</span>
                      <span>·</span>
                      <span>{textOf(item.distance)}</span>
                    </div>
                    <div className="tag-row">
                      {tags.map(tag => (
                        <span className="mini-tag" key={`${key}-${index}-${tag}`}>
                          {tag}
                        </span>
                      ))}
                      <span className="source-tag">{textOf(item.sourceTag)}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      );
    }

    case 'RideOptions': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="ride-list">
            {items.map((item, index) => (
              <article className="ride-card" key={`${key}-ride-${index}`}>
                <span className="ride-mark">
                  <Icon name="car" size={17} />
                </span>
                <div className="ride-main">
                  <strong>{textOf(item.provider)}</strong>
                  <span>
                    {textOf(item.car)} · {textOf(item.eta)}
                  </span>
                  <span className="ride-distance">{textOf(item.distance)}</span>
                </div>
                <div className="ride-side">
                  <em>{textOf(item.price)}</em>
                  <span className="source-tag">{textOf(item.sourceTag)}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      );
    }

    case 'PaymentCard': {
      const item = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      return (
        <div className="payment-card" key={key}>
          <div className="payment-top">
            <span className="payment-mark">
              <Icon name="lock" size={15} />
            </span>
            <div>
              <strong>{textOf(item.title) || tr('Confirm payment', '确认支付')}</strong>
              <span>{textOf(item.merchant)}</span>
            </div>
            <em>{textOf(item.amount)}</em>
          </div>
          <div className="payment-rows">
            <div>
              <span>{tr('Payment method', '支付方式')}</span>
              <strong>{textOf(item.method)}</strong>
            </div>
            <div>
              <span>{tr('Status', '状态')}</span>
              <strong className="is-warn">{textOf(item.status)}</strong>
            </div>
          </div>
          {item.note ? <p className="payment-note">{textOf(item.note)}</p> : null}
        </div>
      );
    }

    case 'HeroBanner':
      return (
        <div className="hero-banner" key={key}>
          <span className="hero-kicker">{tr('A2UI surface', 'A2UI 界面')}</span>
          <h3>{component.title}</h3>
          {component.body ? <p>{component.body}</p> : null}
          {component.actions?.length ? (
            <div className="a2ui-actions">
              {component.actions.map((action, index) => actionButton(action, ctx, `${key}-hero-${index}`))}
            </div>
          ) : null}
        </div>
      );

    case 'FlightBoard': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="flight-board">
            {items.map((item, index) => (
              <div className="flight-row" key={`${key}-flight-${index}`}>
                <span className="flight-code">{item.code}</span>
                <div className="flight-route">
                  <strong>{item.depart} <small>{item.from}</small></strong>
                  <span>→</span>
                  <strong>{item.arrive} <small>{item.to}</small></strong>
                </div>
                <div className="flight-side">
                  <span className={`flight-status ${item.status?.toLowerCase().includes('delay') ? 'is-warn' : ''}`}>{item.status}</span>
                  <span>{item.gate}</span>
                  <span className="source-tag">{item.sourceTag}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'List': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="a2ui-list">
            {items.map((item, index) => (
              <div className="a2ui-list-row" key={`${key}-list-${index}`}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                </div>
                <em>{item.meta}</em>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'Checklist': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="a2ui-checklist">
            {items.map((item, index) => (
              <label className="checklist-row" key={`${key}-check-${index}`}>
                <input type="checkbox" defaultChecked={item.checked === true} />
                <span className="checklist-box" aria-hidden="true">
                  <Icon name="check" size={11} />
                </span>
                <span className="checklist-copy">
                  <strong>{textOf(item.label)}</strong>
                  {item.note ? <em>{textOf(item.note)}</em> : null}
                </span>
                {item.meta ? <span className="checklist-meta">{textOf(item.meta)}</span> : null}
              </label>
            ))}
          </div>
        </div>
      );
    }

    case 'ToolConnectCard':
      return (
        <div className="tool-connect-card" key={key}>
          <span className="tool-connect-icon">
            <Icon name="globe" size={16} />
          </span>
          <div className="tool-connect-main">
            <strong>{component.title}</strong>
            <p>{component.body}</p>
            {component.status ? <span className="tool-connect-status">{component.status}</span> : null}
            {component.actions?.length ? (
              <div className="a2ui-actions">
                {component.actions.map((action, index) => actionButton(action, ctx, `${key}-tool-${index}`))}
              </div>
            ) : null}
          </div>
        </div>
      );

    case 'ExpandableCard': {
      const rows = (resolvePath(surface.data, component.dataPath) ?? component.rows ?? []) as Array<Record<string, string>>;
      return (
        <details className="expandable-card" key={key}>
          <summary>
            <span>
              <strong>{component.title}</strong>
              {component.body ? <em>{component.body}</em> : null}
            </span>
            <Icon name="chevronDown" size={14} />
          </summary>
          <div className="info-rows">
            {rows.map((row, index) => (
              <div className="info-row" key={`${key}-expand-${index}`}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        </details>
      );
    }

    case 'SkeletonCard':
      return (
        <div className="skeleton-card" key={key}>
          <div className="skeleton-line is-short" />
          <div className="skeleton-line" />
          <div className="skeleton-line is-medium" />
          {component.title ? <span>{component.title}</span> : null}
        </div>
      );

    case 'MediaSlider': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="media-slider">
            {items.map((item, index) => (
              <div className={`media-tile media-tone-${(index % 3) + 1}`} key={`${key}-media-${index}`}>
                <span className="media-kind">{item.kind}</span>
                <strong>{item.title}</strong>
                <em>{item.meta}</em>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'SceneTabs': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="scene-tabs" key={key}>
          {items.map((item, index) => (
            <span className={index === 0 ? 'is-active' : ''} key={`${key}-tab-${index}`}>
              {item.label}
            </span>
          ))}
        </div>
      );
    }

    case 'MasonryGrid': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="masonry-grid" key={key}>
          {items.map((item, index) => (
            <div className={`masonry-item tone-${item.tone ?? 'muted'}`} key={`${key}-masonry-${index}`}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </div>
          ))}
        </div>
      );
    }

    case 'SegmentedRingChart': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, unknown>>;
      let cursor = 0;
      const stops = items
        .map(item => {
          const start = cursor;
          cursor += Number(item.percent) || 0;
          return `${chartColor(typeof item.tone === 'string' ? item.tone : undefined)} ${start}% ${cursor}%`;
        })
        .join(', ');
      const total = items.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="ring-chart">
            <div
              className="ring-figure"
              style={{ background: `conic-gradient(${stops || '#eee 0% 100%'})` }}
              role="img"
              aria-label={component.title ?? tr('Task mix', '任务构成')}
            >
              <div className="ring-hole">
                <strong>{total}</strong>
                <span>{tr('tasks', '任务')}</span>
              </div>
            </div>
            <div className="ring-legend">
              {items.map((item, index) => (
                <div className="ring-legend-row" key={`${key}-ring-${index}`}>
                  <span
                    className="ring-dot"
                    style={{ background: chartColor(typeof item.tone === 'string' ? item.tone : undefined) }}
                  />
                  <span>{textOf(item.label)}</span>
                  <em>{textOf(item.percent)}%</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    case 'MultiSeriesLineChart': {
      const chart = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      const labels = (chart.labels as string[]) ?? [];
      const series = (chart.series as Array<Record<string, unknown>>) ?? [];
      const allValues = series.flatMap(item => ((item.points as number[]) ?? []).map(Number));
      const max = Math.max(1, ...allValues);
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div className="line-legend">
            {series.map((item, index) => (
              <span key={`${key}-legend-${index}`}>
                <i style={{ background: chartColor(typeof item.tone === 'string' ? item.tone : undefined) }} />
                {textOf(item.name)}
              </span>
            ))}
          </div>
          <svg
            className="line-chart"
            viewBox="0 0 100 42"
            preserveAspectRatio="none"
            role="img"
            aria-label={component.title ?? tr('Activity chart', '活跃度图表')}
          >
            <line x1="0" y1="38" x2="100" y2="38" className="chart-axis" vectorEffect="non-scaling-stroke" />
            {[10, 19, 28].map(y => (
              <line key={`${key}-grid-${y}`} x1="0" y1={y} x2="100" y2={y} className="chart-grid" vectorEffect="non-scaling-stroke" />
            ))}
            {series.map((item, index) => {
              const points = (item.points as number[]) ?? [];
              const path = points
                .map((value, pointIndex) => {
                  const x = points.length <= 1 ? 0 : (pointIndex / (points.length - 1)) * 100;
                  const y = 38 - (Number(value) / max) * 34;
                  return `${x.toFixed(2)},${y.toFixed(2)}`;
                })
                .join(' ');
              return (
                <polyline
                  key={`${key}-line-${index}`}
                  className="chart-line"
                  points={path}
                  fill="none"
                  stroke={chartColor(typeof item.tone === 'string' ? item.tone : undefined)}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          <div className="line-labels">
            {labels.map((label, index) => (
              <span key={`${key}-label-${index}`}>{label}</span>
            ))}
          </div>
        </div>
      );
    }

    case 'MatrixHeatmap': {
      const heat = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      const cols = (heat.cols as string[]) ?? [];
      const rows = (heat.rows as string[]) ?? [];
      const values = (heat.values as number[][]) ?? [];
      return (
        <div className="options-block" key={key}>
          {component.title ? <div className="block-title">{component.title}</div> : null}
          <div
            className="heatmap"
            style={{ gridTemplateColumns: `34px repeat(${Math.max(cols.length, 1)}, 1fr)` }}
            role="img"
            aria-label={component.title ?? tr('Focus heatmap', '专注热力图')}
          >
            <span />
            {cols.map((col, index) => (
              <span className="heat-col" key={`${key}-col-${index}`}>
                {col}
              </span>
            ))}
            {rows.flatMap((row, rowIndex) => [
              <span className="heat-row" key={`${key}-row-${rowIndex}`}>
                {row}
              </span>,
              ...cols.map((col, colIndex) => {
                const value = Math.max(0, Math.min(4, Number(values[rowIndex]?.[colIndex]) || 0));
                return (
                  <span
                    className={`heat-cell heat-${value}`}
                    key={`${key}-cell-${rowIndex}-${colIndex}`}
                    title={`${row} ${col}: ${value}`}
                  />
                );
              })
            ])}
          </div>
          <div className="heat-scale">
            <span>{tr('Less', '少')}</span>
            {[0, 1, 2, 3, 4].map(level => (
              <i className={`heat-cell heat-${level}`} key={`${key}-scale-${level}`} />
            ))}
            <span>{tr('More', '多')}</span>
          </div>
        </div>
      );
    }

    case 'ThinkingCard': {
      const state = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      const steps = (state.steps as Array<Record<string, string>>) ?? [];
      const done = state.done === true;
      return (
        <div className={`a2ui-thinking-card ${done ? 'is-done' : ''}`} key={key}>
          <div className="a2ui-thinking-head">
            <span className={`a2ui-thinking-orb ${done ? 'is-done' : ''}`}>
              <Icon name={done ? 'check' : 'spark'} size={13} />
            </span>
            <strong>{textOf(state.title) || component.title || tr('Thinking', '思考中')}</strong>
            <span className="a2ui-thinking-state">
              {done ? tr('Done', '已完成') : tr('Working', '处理中')}
            </span>
          </div>
          <div className="thinking-inline">
            {steps.map((step, index) => (
              <div className="thinking-step" key={`${key}-a2ui-think-${index}`}>
                <span className={`step-dot ${step.status ?? 'pending'}`} />
                <span>{textOf(step.label)}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'StripeReceivingAccountCard': {
      const account = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      return (
        <div className="receiving-card" key={key}>
          <div className="receiving-head">
            <span className="receiving-mark">
              <Icon name="shield" size={16} />
            </span>
            <div>
              <strong>{textOf(account.provider) || component.title}</strong>
              <span>{textOf(account.maskedAccount)}</span>
            </div>
            <span className="receiving-status">{textOf(account.status)}</span>
          </div>
          <div className="info-rows">
            {[
              [tr('Payout schedule', '结算周期'), account.schedule],
              [tr('Currency', '币种'), account.currency],
              [tr('Available balance', '可用余额'), account.balance]
            ]
              .filter(([, value]) => textOf(value))
              .map(([label, value]) => (
                <div className="info-row" key={`${key}-receiving-${String(label)}`}>
                  <span>{String(label)}</span>
                  <strong>{textOf(value)}</strong>
                </div>
              ))}
          </div>
          <p className="receiving-note">
            <Icon name="lock" size={12} />
            {textOf(account.note)}
          </p>
        </div>
      );
    }

    case 'ApprovalCard': {
      const approval = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      return (
        <div className="approval-card" key={key}>
          <div className="approval-head">
            <span className="approval-mark">
              <Icon name="shield" size={16} />
            </span>
            <div>
              <strong>{textOf(approval.title) || component.title}</strong>
              <span>{textOf(approval.body)}</span>
            </div>
            {approval.risk ? <span className="approval-risk">{textOf(approval.risk)}</span> : null}
          </div>
          <div className="approval-meta">
            {approval.expires ? (
              <span>
                <Icon name="clock" size={11} />
                {textOf(approval.expires)}
              </span>
            ) : null}
            {approval.scope ? <span>{textOf(approval.scope)}</span> : null}
          </div>
          {component.actions?.length ? (
            <div className="a2ui-actions">
              {component.actions.map((action, index) => actionButton(action, ctx, `${key}-approval-${index}`))}
            </div>
          ) : null}
        </div>
      );
    }

    case 'ConnectionQuotaCard': {
      const quota = (resolvePath(surface.data, component.dataPath) ?? {}) as Record<string, unknown>;
      const percent = Math.max(0, Math.min(100, Number(quota.percent) || 0));
      return (
        <div className="quota-card" key={key}>
          <div className="quota-head">
            <span className="quota-mark">
              <Icon name="globe" size={16} />
            </span>
            <div>
              <strong>{textOf(quota.service) || component.title}</strong>
              <span>{textOf(quota.plan)}</span>
            </div>
            <span className="quota-status">{textOf(quota.status)}</span>
          </div>
          <div className="quota-bar" role="img" aria-label={`${percent}%`}>
            <i style={{ width: `${percent}%` }} />
          </div>
          <div className="quota-legend">
            <span>
              {textOf(quota.used)} / {textOf(quota.limit)}
            </span>
            <span>{textOf(quota.reset)}</span>
          </div>
          {quota.note ? <p className="quota-note">{textOf(quota.note)}</p> : null}
        </div>
      );
    }

    case 'FilePicker':
    case 'ChoiceGroup':
    case 'TextField':
    case 'Toggle':
    case 'FrameGallery':
    case 'StepList':
    case 'VideoPlayer':
      return renderEpicComponent(component, ctx, key);

    case 'ThinkingStream': {
      const items = (resolvePath(surface.data, component.dataPath) ?? []) as Array<Record<string, string>>;
      return (
        <div className="options-block" key={key}>
          <div className="thinking-inline">
            {items.map((item, index) => (
              <div className="thinking-step" key={`${key}-think-${index}`}>
                <span className={`step-dot ${item.status ?? 'pending'}`} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    default:
      return (
        <div className="a2ui-error" key={key}>
          <Icon name="info" size={16} />
          <div>
            <strong>{tr('Unknown component', '未知组件')}</strong>
            <p>{component.component}</p>
          </div>
        </div>
      );
  }
}

export function A2uiSurfaceView({ surface, onAction, onDetails, form, onInput }: SurfaceProps) {
  const { tr } = useI18n();
  const root = surface.components[surface.root];
  if (!root) return null;
  return (
    <div className="a2ui-root">
      {renderComponent(root, { surface, onAction, onDetails, form, onInput, tr }, 'root')}
    </div>
  );
}
