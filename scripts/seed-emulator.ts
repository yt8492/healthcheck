import { Firestore } from '@google-cloud/firestore';
import { recentRange } from '@healthcheck/core';
import { GoogleHealthClient } from '@healthcheck/google-health';
import { HeartStore } from '@healthcheck/storage';
import { syncHeart } from '../apps/sync/src/sync.js';
import { fixturePoints, rollupPage } from '../tests/fixtures.js';

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
} finally { await store.db.terminate(); }
