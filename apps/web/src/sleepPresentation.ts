import type { SleepSession, SleepStageType } from '@healthcheck/core';

export const sleepLabels: Record<SleepStageType, string> = {
  awake: '覚醒・離床', restless: '落ち着かない', rem: 'レム睡眠', light: '浅い睡眠',
  deep: '深い睡眠', asleep: '睡眠（段階なし）', unknown: '段階未提供',
};
export const sleepColors: Record<SleepStageType, string> = {
  awake: '#e78baa', restless: '#e2bd70', rem: '#75cde1', light: '#7fafff',
  deep: '#b38cdb', asleep: '#94c5b0', unknown: '#a8b3bf',
};
export function sleepDurationParts(minutes: number) {
  const rounded = Math.round(minutes * 10);
  return { hours: Math.floor(rounded / 600), minutes: (rounded % 600) / 10 };
}
export function sleepMinutes(value: number | null): string {
  if (value === null) return '不明';
  const parts = sleepDurationParts(value);
  return `${parts.hours ? `${parts.hours}時間` : ''}${parts.minutes}分`;
}
export function sleepRows(session: SleepSession): SleepStageType[] {
  const order: SleepStageType[] = ['awake', 'restless', 'rem', 'light', 'deep', 'asleep', 'unknown'];
  const standard: SleepStageType[] = session.type === 'stages' ? ['awake', 'rem', 'light', 'deep']
    : session.type === 'classic' ? ['awake', 'restless', 'asleep'] : [];
  return order.filter(type => standard.includes(type) || session.stageMinutes[type] > 0);
}
