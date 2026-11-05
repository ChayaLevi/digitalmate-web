import type { HomemindAlert, Lang } from '../../server/homemind/types';
import { alertButtons, alertText, alertTitle } from '../lib/homemindAlerts';
import type { AlertButton } from '../lib/homemindAlerts';

/**
 * Live alerts from the Homemind stream (T3.3), above the Family screens. The host decides what each
 * button does; this only draws them. The region is polite: an alert is read out, not forced.
 */
export function AlertBanner({
  alerts,
  lang,
  busy,
  onButton
}: {
  alerts: readonly HomemindAlert[];
  lang: Lang;
  busy?: boolean;
  onButton: (alert: HomemindAlert, verb: AlertButton['verb']) => void;
}) {
  return (
    <section className="hm-alerts" aria-label={lang === 'zh' ? '提醒' : 'Alerts'} aria-live="polite">
      {alerts.map(alert => {
        const title = alertTitle(alert, lang);
        return (
          <div key={alert.id} className={`hm-alert is-${alert.kind}`} data-alert-id={alert.id} data-item-id={alert.itemId} data-kind={alert.kind}>
            <p>{alertText(alert, lang)}</p>
            <div className="hm-alert-actions">
              {alertButtons(alert, lang).map(button => (
                <button
                  key={button.verb}
                  type="button"
                  className={button.verb === 'ack' || button.verb === 'claim' ? 'is-primary' : undefined}
                  aria-label={`${button.label}: ${title}`}
                  disabled={busy && button.verb !== 'dismiss'}
                  onClick={() => onButton(alert, button.verb)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
