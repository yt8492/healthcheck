import type { SleepSession, SleepStageType } from '@healthcheck/core';

export const sleepLabels: Record<SleepStageType, string> = {
  awake: '覚醒・離床', restless: '落ち着かない', rem: 'レム睡眠', light: '浅い睡眠',
  deep: '深い睡眠', asleep: '睡眠（段階なし）', unknown: '段階未提供',
};
export const sleepColors: Record<SleepStageType, string> = {
  awake: '#d34e85', restless: '#cf9609', rem: '#55cbe5', light: '#4778f5',
  deep: '#60278c', asleep: '#547565', unknown: '#8c97a3',
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
