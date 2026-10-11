import { createStore } from '@healthcheck/storage';
import { createApp } from './app.js';

const store = createStore();
const app = await createApp(store, { logger: true });
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  await app.close(); await store.db.terminate();
});
