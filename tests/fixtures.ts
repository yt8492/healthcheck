import { DAY, HOUR, MINUTE, emptyPoints, normalizeSleep, type HeartPoint, type TimeRange } from '@healthcheck/core';

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

export function sleepPoint(id: number, startTime = '2026-10-09T13:00:00Z', endTime = '2026-10-09T21:00:00Z') {
  const start = Date.parse(startTime), end = Date.parse(endTime), duration = end - start;
  const at = (fraction: number) => new Date(start + duration * fraction).toISOString();
  return { dataPointName: `users/fictional/dataTypes/sleep/dataPoints/fixture-${id}`, sleep: {
    interval: { startTime, endTime }, type: 'STAGES', metadata: { nap: false },
    stages: [{ startTime: at(0), endTime: at(.25), type: 'LIGHT' },
      { startTime: at(.25), endTime: at(.5), type: 'DEEP' },
      { startTime: at(.5), endTime: at(.75), type: 'REM' },
      { startTime: at(.75), endTime: at(1), type: 'LIGHT' }],
    shortAwakenings: [{ startTime: at(.1), endTime: at(.12), type: 'AWAKE' }],
  } };
}
export function fixtureSleep(range: TimeRange) {
  const sessions = [];
  for (let day = Math.floor(Date.parse(range.from) / DAY) * DAY - DAY; day < Date.parse(range.to); day += DAY) {
    for (const [offset, duration] of [[13 * HOUR, 8 * HOUR], [3 * HOUR, 45 * MINUTE]]) {
      const start = day + offset!, end = start + duration!;
      if (end < Date.parse(range.from) || end >= Date.parse(range.to)) continue;
      const raw = sleepPoint(start, new Date(start).toISOString(), new Date(end).toISOString()).sleep;
      if (duration! < HOUR) { raw.metadata.nap = true; raw.type = 'CLASSIC'; raw.stages = [{ startTime: raw.interval.startTime, endTime: raw.interval.endTime, type: 'ASLEEP' }]; }
      sessions.push(normalizeSleep(start.toString(16).padStart(64, '0'), raw));
    }
  }
  return sessions.sort((a, b) => a.endTime.localeCompare(b.endTime) || a.id.localeCompare(b.id));
}
