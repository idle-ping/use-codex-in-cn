// Quota percentages come from app-server, independently of thread token usage.
export function codexRateLimits(payload) {
  const buckets = payload?.rateLimitsByLimitId;
  if (buckets?.codex) return buckets.codex;
  const legacy = payload?.rateLimits;
  return legacy && (!legacy.limitId || legacy.limitId === 'codex') ? legacy : null;
}

export function quotaWindows(limits) {
  const windows = [limits?.primary, limits?.secondary];
  return [300, 10080].map((minutes, index) => {
    const window = windows.find(value => value?.windowDurationMins === minutes)
      || (windows[index]?.windowDurationMins == null ? windows[index] : null);
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
    const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
    const resetsAt = typeof window.resetsAt === 'number' && window.resetsAt > 0
      && Number.isFinite(window.resetsAt) && Number.isFinite(new Date(window.resetsAt * 1000).getTime())
      ? window.resetsAt : null;
    return { usedPercent, remainingPercent: 100 - usedPercent, resetsAt };
  });
}

export function resetCountdown(resetsAt, now = Date.now()) {
  const remainingMinutes = Math.max(0, Math.ceil((Number(resetsAt) * 1000 - now) / 60000));
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  return { days, hours, minutes: remainingMinutes % 60 };
}

export function renderQuotaWindows(container, limits, { t = value => value, locale = 'en', now = Date.now() } = {}) {
  const document = container.ownerDocument;
  container.replaceChildren();
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  quotaWindows(limits).forEach((window, index) => {
    if (index === 0 && !window) return;
    const card = document.createElement('div');
    card.className = 'usage-card';
    const heading = document.createElement('strong');
    heading.textContent = t(index === 0 ? '5-hour limit' : 'Weekly limit');
    card.append(heading);
    if (window) {
      const summary = document.createElement('p');
      summary.textContent = `${formatter.format(window.usedPercent)}% ${t('used')} · ${formatter.format(window.remainingPercent)}% ${t('remaining')}`;
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = window.usedPercent;
      progress.setAttribute('aria-label', heading.textContent);
      const reset = document.createElement('small');
      reset.textContent = window.resetsAt
        ? `${t('Resets at')}: ${t('Resets in {days}d {hours}h {minutes}m', resetCountdown(window.resetsAt, now))}`
        : t('Reset time unavailable');
      card.append(summary, progress, reset);
    } else {
      const empty = document.createElement('p');
      empty.textContent = t('Usage data unavailable');
      card.append(empty);
    }
    container.append(card);
  });
}
