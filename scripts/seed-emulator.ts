import { Firestore } from '@google-cloud/firestore';
import { ACTIVITY_METRICS, DAY, emptyActivity, recentRange, retentionStart } from '@healthcheck/core';
import { GoogleHealthClient } from '@healthcheck/google-health';
import { HeartStore } from '@healthcheck/storage';
import { syncHeart } from '../apps/sync/src/sync.js';
import { fixturePoints, fixtureSleep, rollupPage } from '../tests/fixtures.js';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('架空データはローカルEmulatorにのみ投入できます。');
if (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== 'demo-healthcheck') throw new Error('検証専用プロジェクトを指定してください。');
process.env.FIRESTORE_EMULATOR_HOST = host;
const store = new HeartStore(new Firestore({ projectId: 'demo-healthcheck' }));
try {
  const range = recentRange(Date.now(), 48);
  const client = new GoogleHealthClient(async () => Response.json(rollupPage(fixturePoints(range))));
  const result = await syncHeart(client, store, range);
  console.log(`Emulatorに48時間の架空データを投入しました。${result.changedHours}時間docを更新。`);
  const sleepRange = recentRange(Date.now(), 90 * 24);
  for (let from = Date.parse(sleepRange.from); from < Date.parse(sleepRange.to); from += 7 * DAY) {
    const part = { from: new Date(from).toISOString(), to: new Date(Math.min(from + 7 * DAY, Date.parse(sleepRange.to))).toISOString() };
    await store.sleep.replace(part, fixtureSleep(part), await store.sleep.acquire());
  }
  for (const metric of ACTIVITY_METRICS) {
    const activity = store.activity(metric);
    for (let from = retentionStart(Date.now()); from < Date.parse(sleepRange.to); from += 7 * DAY) {
      const part = { from: new Date(from).toISOString(), to: new Date(Math.min(from + 7 * DAY, Date.parse(sleepRange.to))).toISOString() };
      const scale = metric === 'distance' ? 0.123 : metric === 'total-calories' ? 1.25 : 1;
      const points = emptyActivity(part).map((p, i) => i % 73 === 0 ? p : i % 61 === 0 ? { ...p, presence: 'omitted' as const, value: null }
        : { ...p, presence: 'value' as const, value: (i % 7) * scale });
      await activity.replace(part, points, await activity.acquire());
    }
  }
  console.log('Emulatorに90日分の架空の活動4指標を投入しました。');
  console.log('Emulatorに90日分の架空の夜間睡眠・昼寝を投入しました。');
} finally { await store.db.terminate(); }
