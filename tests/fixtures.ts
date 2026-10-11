import { MINUTE, emptyPoints, type HeartPoint, type TimeRange } from '@healthcheck/core';

// 架空値のみ。実デバイスの値や本人の生活時刻を複製しない。
export function fixturePoints(range: TimeRange): HeartPoint[] {
  return emptyPoints(range).map((point, i) => {
    const ms = Date.parse(point.time), minuteOfDay = ((ms / MINUTE + 9 * 60) % 1440);
    if (minuteOfDay >= 660 && minuteOfDay < 690) return point;
    const sleep = minuteOfDay < 420, exercise = minuteOfDay > 1050 && minuteOfDay < 1110;
    const avg = Math.round(((sleep ? 55 : 73) + (exercise ? 45 + 18 * Math.sin(i / 12) : 0) + 5 * Math.sin(i / 31) + 3 * Math.sin(i / 5)) * 10) / 10;
    return { ...point, value: { avg, min: Math.round((avg - 3) * 10) / 10, max: Math.round((avg + 5) * 10) / 10 } };
  });
}
export function rollupPage(points: HeartPoint[], nextPageToken?: string) {
  return { rollupDataPoints: points.map(point => ({ startTime: point.time,
    endTime: new Date(Date.parse(point.time) + MINUTE).toISOString(),
    ...(point.value ? { heartRate: { beatsPerMinuteAvg: point.value.avg, beatsPerMinuteMin: point.value.min, beatsPerMinuteMax: point.value.max } } : {}),
  })), ...(nextPageToken ? { nextPageToken } : {}) };
}
