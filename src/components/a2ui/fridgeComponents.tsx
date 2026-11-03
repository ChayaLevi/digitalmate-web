import { useState } from 'react';
import type { ReactNode } from 'react';
import type { A2uiAction, A2uiComponent, A2uiSurface } from '../../types';
import { Icon } from '../Icons';

/**
 * Fridge2Table catalog component: RecipeOptions, a list of meal cards with the dish photo, time,
 * what it uses from the kitchen, and per-card actions ("Show steps", "I made it").
 * Data: Array<{id, name, time, servings?, uses, requested?, photo?, actions: A2uiAction[]}>.
 */
interface Ctx {
  surface: A2uiSurface;
  onAction: (action: A2uiAction) => void;
  tr: (en: string, zh: string) => string;
}

interface Meal {
  id: string;
  name: string;
  time?: string;
  servings?: string;
  uses?: string;
  requested?: boolean;
  photo?: string;
  actions?: A2uiAction[];
}

function resolve(data: unknown, path?: string): unknown {
  if (!path || path === '/') return data;
  return path
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((value, segment) => (value as Record<string, unknown> | undefined)?.[segment], data);
}

function MealPhoto({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="recipe-photo is-empty" aria-hidden="true">
        <Icon name="spark" size={18} />
      </span>
    );
  }
  return <img className="recipe-photo" src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />;
}

export function renderFridgeComponent(component: A2uiComponent, ctx: Ctx, key: string): ReactNode {
  if (component.component !== 'RecipeOptions') return null;
  const raw = resolve(ctx.surface.data, typeof component.dataPath === 'string' ? component.dataPath : undefined);
  const meals = (Array.isArray(raw) ? raw : []) as Meal[];
  return (
    <div className="options-block" key={key}>
      {component.title ? <div className="block-title">{component.title}</div> : null}
      <div className="recipe-list">
        {meals.map(meal => (
          <article className="recipe-card" key={`${key}-${meal.id}`} data-recipe-id={meal.id}>
            <MealPhoto src={meal.photo} name={meal.name} />
            <div className="recipe-main">
              <div className="recipe-title-line">
                <strong>{meal.name}</strong>
                {meal.requested ? <span className="recipe-badge">{ctx.tr('You asked', '你点的')}</span> : null}
              </div>
              <div className="recipe-meta">
                {meal.time ? <span>{meal.time}</span> : null}
                {meal.servings ? <span>{meal.servings}</span> : null}
              </div>
              {meal.uses ? (
                <p className="recipe-uses">
                  {ctx.tr('Uses', '用到')}: {meal.uses}
                </p>
              ) : null}
              {meal.actions?.length ? (
                <div className="recipe-actions">
                  {meal.actions.map((action, index) => (
                    <button
                      key={`${key}-${meal.id}-${index}`}
                      type="button"
                      className={`a2ui-button ${action.variant === 'primary' ? 'is-primary' : action.variant === 'ghost' ? 'is-ghost' : 'is-secondary'}`}
                      onClick={() => ctx.onAction(action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
