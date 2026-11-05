import type { ReactNode } from 'react';
import type { A2uiComponent, A2uiSurface } from '../../types';

/**
 * Data-bearing A2UI components used by the Epic Replay surfaces: a file picker, single-choice
 * group, text field, toggle, frame gallery, step list and video player. They read their current
 * value from `form` and report changes through `onInput`; the host decides when to submit.
 */
interface Ctx {
  surface: A2uiSurface;
  onAction?: (action: { id: string; label: string }) => void;
  form?: Record<string, unknown>;
  onInput?: (name: string, value: unknown) => void;
}

interface Option {
  value: string;
  label: string;
  description?: string;
  sample?: string;
}

interface Frame {
  frame: number;
  url: string;
  label?: string;
  main?: boolean;
}

interface Step {
  n: number;
  name: string;
  status: string;
  duration_s?: number | null;
}

interface ReplayItem {
  runId: string;
  date: string;
  headline: string;
  narrator: string;
  chinese: boolean;
  duration: string;
  thumb: string | null;
  action: { id: string; label: string };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function renderEpicComponent(component: A2uiComponent, ctx: Ctx, key: string): ReactNode {
  const name = str(component.name);
  const current = ctx.form?.[name];
  const set = (value: unknown) => ctx.onInput?.(name, value);

  switch (component.component) {
    case 'FilePicker': {
      const file = current instanceof File ? current : null;
      return (
        <div className="epic-field" key={key}>
          <div className="block-title">{str(component.title)}</div>
          <label className="epic-file">
            <input
              type="file"
              accept={str(component.accept) || undefined}
              data-testid="epic-file"
              onChange={event => set(event.target.files?.[0] ?? null)}
            />
            <span className="secondary-action">{file ? file.name : str(component.label)}</span>
            {file ? <em>{(file.size / (1024 * 1024)).toFixed(1)} MB</em> : null}
          </label>
        </div>
      );
    }

    case 'ChoiceGroup': {
      const options = (component.options ?? []) as Option[];
      const selected = str(current) || str(component.default);
      return (
        <div className="epic-field" key={key} role="radiogroup" aria-label={str(component.title)}>
          <div className="block-title">{str(component.title)}</div>
          <div className="epic-choices">
            {options.map(option => (
              <button
                type="button"
                role="radio"
                aria-checked={selected === option.value}
                className={`epic-choice${selected === option.value ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => set(option.value)}
              >
                <strong>{option.label}</strong>
                {option.description ? <em>{option.description}</em> : null}
              </button>
            ))}
          </div>
        </div>
      );
    }

    case 'TextField': {
      const value = current === undefined ? str(component.default) : str(current);
      // `inputType` (Homemind forms) picks a date or time input; anything else stays a text field.
      const inputType = ['date', 'time'].includes(str(component.inputType)) ? str(component.inputType) : 'text';
      return (
        <label className="epic-field epic-text" key={key}>
          <span className="block-title">{str(component.label)}</span>
          <input
            type={inputType}
            value={value}
            maxLength={typeof component.maxLength === 'number' ? component.maxLength : undefined}
            onChange={event => set(event.target.value)}
          />
        </label>
      );
    }

    case 'Toggle': {
      const checked = current === undefined ? component.default === true : current === true;
      return (
        <label className="epic-field epic-toggle" key={key}>
          <input type="checkbox" checked={checked} onChange={event => set(event.target.checked)} />
          <span>{str(component.label)}</span>
        </label>
      );
    }

    case 'FrameGallery': {
      const frames = (component.frames ?? []) as Frame[];
      const selected = typeof current === 'number' ? current : (component.default as number | undefined);
      return (
        <div className="epic-field" key={key}>
          <div className="block-title">{str(component.title)}</div>
          <div className="epic-frames" role="radiogroup" aria-label={str(component.title)}>
            {frames.map(frame => (
              <button
                type="button"
                role="radio"
                aria-checked={selected === frame.frame}
                className={`epic-frame${selected === frame.frame ? ' is-selected' : ''}`}
                key={frame.frame}
                onClick={() => set(frame.frame)}
              >
                <img src={frame.url} alt={`Frame ${frame.frame}`} loading="lazy" />
                <span>{frame.label ?? `#${frame.frame}`}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }

    case 'StepList': {
      const path = str(component.dataPath).split('/').filter(Boolean);
      const raw = path.reduce<unknown>((value, segment) => (value as Record<string, unknown> | undefined)?.[segment], ctx.surface.data);
      const steps = (Array.isArray(raw) ? raw : []) as Step[];
      return (
        <ol className="epic-steps" key={key} aria-label="Progress">
          {steps.map(step => (
            <li key={step.n} className={`epic-step is-${step.status}`} data-status={step.status}>
              <span className="epic-step-dot" aria-hidden="true" />
              <span>{step.name}</span>
              {step.status === 'done' && step.duration_s ? <em>{step.duration_s}s</em> : null}
            </li>
          ))}
        </ol>
      );
    }

    case 'VideoPlayer':
      return (
        <div className="epic-field" key={key}>
          <video className="epic-video" controls playsInline preload="metadata" src={str(component.src)} aria-label={str(component.title)} data-testid="epic-video" />
          <a className="secondary-action epic-download" href={str(component.src)} download="epic-replay.mp4">
            Download MP4
          </a>
        </div>
      );

    case 'ReplayList': {
      const items = (component.items ?? []) as ReplayItem[];
      return (
        <div className="epic-replays" key={key}>
          {items.map(item => (
            <button
              type="button"
              className="epic-replay"
              key={item.runId}
              onClick={() => ctx.onAction?.(item.action)}
              aria-label={`${item.action.label}: ${item.headline || item.narrator}, ${item.date}`}
            >
              {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <span className="epic-replay-blank" aria-hidden="true" />}
              <strong>{item.headline || item.narrator}</strong>
              <em>
                {[item.date, item.narrator, item.chinese ? '中文' : '', item.duration].filter(Boolean).join(' · ')}
              </em>
            </button>
          ))}
        </div>
      );
    }

    default:
      return null;
  }
}
