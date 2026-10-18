import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { codexRateLimits, quotaWindows, renderQuotaWindows, resetCountdown } from '../public/account-usage.js';
import { translate } from '../public/i18n.js';

const short = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 };
const weekly = { usedPercent: 72.5, windowDurationMins: 10080, resetsAt: 1800500000 };

test('selects the Codex bucket rather than another model quota', () => {
  const codex = { primary: short, secondary: weekly };
  expect(codexRateLimits({ rateLimitsByLimitId: { codex }, rateLimits: { limitId: 'other' } })).toBe(codex);
  expect(codexRateLimits({ rateLimits: codex })).toBe(codex);
  expect(codexRateLimits({ rateLimits: { limitId: 'other', primary: short } })).toBeNull();
  expect(codexRateLimits({ rateLimitsByLimitId: { other: codex } })).toBeNull();
});

test('matches quota duration even when primary and secondary are reversed', () => {
  expect(quotaWindows({ primary: weekly, secondary: short }).map(w => w?.usedPercent)).toEqual([25, 72.5]);
  expect(quotaWindows({ primary: { usedPercent: 10 } })[0]?.usedPercent).toBe(10);
  expect(quotaWindows({ primary: { ...short, windowDurationMins: 15 } })).toEqual([null, null]);
});

test('missing and invalid quotas are unknown rather than zero usage', () => {
  expect(quotaWindows(null)).toEqual([null, null]);
  for (const value of [null, '25', NaN, Infinity]) {
    expect(quotaWindows({ primary: { ...short, usedPercent: value } })[0]).toBeNull();
  }
  expect(quotaWindows({ primary: { ...short, usedPercent: 120, resetsAt: NaN } })[0]).toEqual({ usedPercent: 100, remainingPercent: 0, resetsAt: null });
});

test('renders percentages, accessible meters and local reset times in Chinese', () => {
  const document = new JSDOM('<div id="usage"></div>').window.document;
  const root = document.querySelector('#usage')!;
  renderQuotaWindows(root, { primary: short, secondary: weekly }, { t: value => translate(value, 'zh-CN'), locale: 'zh-CN' });
  expect(root.textContent).toContain('5 小时额度');
  expect(root.textContent).toContain('25% 已用 · 75% 剩余');
  expect(root.textContent).toContain('每周额度');
  expect(root.textContent).toContain('重置时间');
  expect(root.querySelector('progress')?.getAttribute('aria-label')).toBe('5 小时额度');
  renderQuotaWindows(root, { primary: weekly });
  expect(root.textContent).not.toContain('5-hour limit');
  expect(root.textContent).toContain('Weekly limit');
  expect(root.querySelectorAll('progress')).toHaveLength(1);
  renderQuotaWindows(root, { primary: { ...short, usedPercent: 0 }, secondary: weekly });
  expect(root.querySelectorAll('progress')).toHaveLength(2);
  renderQuotaWindows(root, null);
  expect(root.textContent).not.toContain('5-hour limit');
  expect(root.querySelector('progress')).toBeNull();
  expect(root.textContent).toContain('Usage data unavailable');
});

test('formats reset time as remaining days and minutes', () => {
  const now = 1_700_000_000_000;
  expect(resetCountdown((now + (2 * 1440 + 2 * 60 + 37) * 60_000 + 10_000) / 1000, now)).toEqual({ days: 2, hours: 2, minutes: 38 });
  const document = new JSDOM('<div id="usage"></div>').window.document;
  renderQuotaWindows(document.querySelector('#usage')!, { primary: { ...short, resetsAt: (now + (2 * 1440 + 2 * 60 + 37) * 60_000 + 10_000) / 1000 } }, { t: (value, values) => translate(value, 'zh-CN', values), locale: 'zh-CN', now });
  expect(document.querySelector('small')?.textContent).toBe('重置时间: 2天2小时38分钟后');
});
