import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  project: { type: 'string' }, region: { type: 'string', default: 'asia-northeast1' },
  image: { type: 'string' },
  'token-file': { type: 'string', default: '.local/google-health-tokens.json' }, help: { type: 'boolean' },
} });
const command = positionals[0];
const project = values.project;
const region = values.region!;
const credentialFile = resolve(values['token-file']!);
const root = resolve('.');
const secret = 'healthcheck-google-health-oauth';
const repository = 'healthcheck';
const job = 'healthcheck-sync';
const scheduler = 'healthcheck-sync-every-15m';
const account = (name: string) => `${name}@${project}.iam.gserviceaccount.com`;

function gcloud(args: string[], capture = false): string {
  const result = spawnSync('gcloud', [...args, `--project=${project}`, '--quiet'], {
    cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw new Error('gcloudを実行できません。Google Cloud CLIをインストールしてください。');
  if (result.status !== 0) throw new Error(capture ? result.stderr : 'Cloud設定が途中で停止しました。成功した設定は保持され、再実行できます。');
  return capture ? result.stdout.trim() : '';
}
function json<T>(args: string[]): T { return JSON.parse(gcloud([...args, '--format=json'], true)) as T; }

async function checkCredentials() {
  try {
    return z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1) })
      .parse(JSON.parse(await readFile(credentialFile, 'utf8')));
  } catch { throw new Error('本人の接続済みOAuth JSONが必要です。npm run connectまたは--token-fileで用意してください。値はログに出さないでください。'); }
}

async function uploadCredentials() {
  await checkCredentials();
  // 秘密を引数や標準出力に展開せず、gcloudがローカルファイルから直接読み取る。
  gcloud(['secrets', 'versions', 'add', secret, `--data-file=${credentialFile}`, '--format=value(name)']);
}

async function ensureSecret() {
  const names = gcloud(['secrets', 'list', `--filter=name:${secret}`, '--format=value(name)'], true).split('\n');
  if (!names.some(name => name === secret || name.endsWith(`/${secret}`))) {
    await checkCredentials();
    gcloud(['secrets', 'create', secret, '--replication-policy=user-managed', `--locations=${region}`]);
  }
}

async function auditUpload() {
  const files = gcloud(['meta', 'list-files-for-upload', '.'], true).split('\n').filter(Boolean);
  for (const required of ['Dockerfile', 'scripts/build.mjs', 'infra/cloudbuild.yaml', 'apps/api/src/server.ts', 'apps/sync/src/cli.ts', 'apps/web/index.html']) {
    if (!files.includes(required)) throw new Error(`送信対象にビルド必須ファイルがありません: ${required}`);
  }
  let privateValues: string[] = [];
  try { privateValues = Object.values(await checkCredentials()); } catch { /* 既存Secretを使う更新ではローカルtokenは不要。 */ }
  for (const file of files) {
    const path = resolve(file);
    if (!path.startsWith(root + sep) || /(^|\/)(\.local|\.git|node_modules|dist|site)(\/|$)|(^|\/)\.env/.test(file)) {
      throw new Error(`Cloud Buildへの送信対象が不正です: ${file}`);
    }
    const text = await readFile(path, 'utf8');
    if (privateValues.some(value => text.includes(value)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`送信ファイルに認証情報が含まれています: ${file}`);
    }
  }
  console.log(`Cloud Build送信前の確認: ${files.length}ファイル、ローカルの認証情報は送信対象外です。`);
}

async function checkFirestoreRules() {
  const accessToken = gcloud(['auth', 'print-access-token'], true);
  const headers = { authorization: `Bearer ${accessToken}`, 'x-goog-user-project': project! };
  const release = await fetch(`https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore`, { headers });
  if (!release.ok) throw new Error('Firestoreルールを確認できません。対象プロジェクトの権限とAPIを確認してください。');
  const name = (await release.json() as { rulesetName: string }).rulesetName;
  const response = await fetch(`https://firebaserules.googleapis.com/v1/${name}`, { headers });
  if (!response.ok) throw new Error('Firestoreルールの内容を確認できません。');
  const source = await response.json() as { source: { files: { content: string }[] } };
  const normalize = (text: string) => text.replace(/\s+/g, '');
  const expected = normalize(await readFile('infra/firestore.rules', 'utf8'));
  if (source.source.files.length !== 1 || normalize(source.source.files[0]!.content) !== expected) {
    throw new Error('Firestoreの直接アクセスを拒否するルールが必要です。infra/firestore.rulesを適用してから公開してください。');
  }
  console.log('Firestoreのクライアント用ルール: 読み書きともに拒否。');
}

async function setServiceLimits() {
  // 古いgcloudでもService全体の上限を設定する。Revision上限だけだと分割配信時に合算される。
  const token = gcloud(['auth', 'print-access-token'], true);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': project! };
  const name = `projects/${project}/locations/${region}/services/healthcheck`;
  const response = await fetch(`https://run.googleapis.com/v2/${name}?updateMask=scaling`, {
    method: 'PATCH', headers, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ name, scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 } }),
  });
  if (!response.ok) throw new Error(`Service全体のインスタンス上限を設定できません（HTTP ${response.status}）。`);
  let operation = await response.json() as { name: string; done?: boolean; error?: unknown };
  const deadline = Date.now() + 120_000;
  while (!operation.done && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const status = await fetch(`https://run.googleapis.com/v2/${operation.name}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!status.ok) throw new Error('Service全体のインスタンス上限の反映を確認できません。');
    operation = await status.json() as typeof operation;
  }
  if (!operation.done || operation.error) throw new Error('Service全体のインスタンス上限の反映が未完了または失敗しました。');
  console.log('Cloud Run Service全体のスケーリング: 最小0・最大1。');
}

async function main() {
  if (values.help || !command) {
    console.log('deploy|credentials --project YOUR_PROJECT_ID [--region asia-northeast1] [--token-file /path/to/token.json] [--image IMAGE_DIGEST]');
    return;
  }
  if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('--projectに対象のプロジェクトIDを明示してください。');
  if (!['deploy', 'credentials'].includes(command) || !/^[a-z]+-[a-z]+[0-9]+$/.test(region)) throw new Error('コマンドまたはリージョンが不正です。--helpを参照してください。');
  const imagePrefix = `${region}-docker.pkg.dev/${project}/${repository}/healthcheck`;
  if (values.image && (!values.image.startsWith(`${imagePrefix}@`) || !/^sha256:[a-f0-9]{64}$/.test(values.image.slice(imagePrefix.length + 1)))) {
    throw new Error('--imageには対象プロジェクトのhealthcheck Repositoryのdigestを指定してください。');
  }
  const db = json<{ locationId: string; type: string }>(['firestore', 'databases', 'describe', '--database=(default)']);
  if (db.locationId !== region || db.type !== 'FIRESTORE_NATIVE') throw new Error('既存のFirestore Native DBと同じリージョンを指定してください。DBの移動や新規作成はしません。');
  const billing = json<{ billingEnabled: boolean }>(['billing', 'projects', 'describe', project]);
  if (!billing.billingEnabled) throw new Error('対象プロジェクトでCloud Billingを有効にしてください。');
  gcloud(['services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
    'secretmanager.googleapis.com', 'cloudscheduler.googleapis.com', 'iam.googleapis.com']);
  await ensureSecret();
  if (command === 'credentials') { await uploadCredentials(); return; }

  await auditUpload();
  await checkFirestoreRules();
  for (const name of ['healthcheck-api', 'healthcheck-sync', 'healthcheck-scheduler', 'healthcheck-build']) {
    const existing = gcloud(['iam', 'service-accounts', 'list', `--filter=email:${account(name)}`, '--format=value(email)'], true);
    if (!existing.split('\n').includes(account(name))) gcloud(['iam', 'service-accounts', 'create', name, `--display-name=${name}`]);
  }
  const repositories = json<{ name: string }[]>(['artifacts', 'repositories', 'list', `--location=${region}`]);
  if (!repositories.some(item => item.name.endsWith(`/${repository}`))) {
    gcloud(['artifacts', 'repositories', 'create', repository, '--repository-format=docker', `--location=${region}`]);
  }
  gcloud(['artifacts', 'repositories', 'set-cleanup-policies', repository, `--location=${region}`,
    '--policy=infra/artifact-cleanup.json', '--no-dry-run']);

  const bucket = `gs://${project}-healthcheck-build-source`;
  const buckets = json<{ name: string }[]>(['storage', 'buckets', 'list']);
  if (!buckets.some(item => item.name === bucket.slice(5))) {
    gcloud(['storage', 'buckets', 'create', bucket, `--location=${region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
  }
  gcloud(['storage', 'buckets', 'update', bucket, '--lifecycle-file=infra/build-source-lifecycle.json']);
  for (const [name, role] of [['healthcheck-api', 'roles/datastore.viewer'], ['healthcheck-sync', 'roles/datastore.user'], ['healthcheck-build', 'roles/logging.logWriter']] as const) {
    gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${account(name)}`, `--role=${role}`, '--condition=None', '--format=none']);
  }
  gcloud(['artifacts', 'repositories', 'add-iam-policy-binding', repository, `--location=${region}`,
    `--member=serviceAccount:${account('healthcheck-build')}`, '--role=roles/artifactregistry.writer', '--format=none']);
  gcloud(['storage', 'buckets', 'add-iam-policy-binding', bucket,
    `--member=serviceAccount:${account('healthcheck-build')}`, '--role=roles/storage.objectViewer', '--format=none']);
  gcloud(['secrets', 'add-iam-policy-binding', secret, `--member=serviceAccount:${account('healthcheck-sync')}`,
    '--role=roles/secretmanager.secretAccessor', '--format=none']);
  const versions = json<{ state: string }[]>(['secrets', 'versions', 'list', secret]);
  if (!versions.some(version => version.state === 'ENABLED')) await uploadCredentials();
  for (const [collection, fieldName] of [['seriesHourly', 'points'], ['sleepSessions', 'stages'], ['hours', 'points'], ['heartDisplayHourly', 'totals'], ['heartDisplayHourly', 'fiveMinutes'], ['heartDisplayDaily', 'totals']] as const) {
    const field = json<{ indexConfig?: { usesAncestorConfig?: boolean; indexes?: unknown[] } }>([
      'firestore', 'indexes', 'fields', 'describe', fieldName, `--collection-group=${collection}`, '--database=(default)',
    ]);
    if (field.indexConfig?.usesAncestorConfig || field.indexConfig?.indexes?.length) {
      gcloud(['firestore', 'indexes', 'fields', 'update', fieldName, `--collection-group=${collection}`, '--database=(default)', '--disable-indexes']);
    }
  }

  let digest = values.image;
  if (!digest) {
    const tag = new Date().toISOString().replace(/[^0-9]/g, '');
    const image = `${imagePrefix}:${tag}`;
    gcloud(['builds', 'submit', '.', '--config=infra/cloudbuild.yaml', '--ignore-file=.gcloudignore', `--region=${region}`,
      `--service-account=projects/${project}/serviceAccounts/${account('healthcheck-build')}`,
      `--gcs-source-staging-dir=${bucket}/source`, `--substitutions=_IMAGE=${image}`]);
    // タグの付け替えに影響されない同一のdigestをServiceとJobに使う。
    const built = json<{ image_summary: { fully_qualified_digest: string } }>(['artifacts', 'docker', 'images', 'describe', image]);
    digest = built.image_summary.fully_qualified_digest;
  }
  if (!digest || !digest.includes('@sha256:')) throw new Error('ビルド済みイメージのdigestを確認できません。');
  gcloud(['run', 'deploy', 'healthcheck', `--image=${digest}`, `--region=${region}`, `--service-account=${account('healthcheck-api')}`,
    '--allow-unauthenticated', '--ingress=all', '--cpu=1', '--memory=512Mi', '--cpu-throttling', '--min=0', '--max-instances=1',
    '--concurrency=40', '--timeout=30s', `--set-env-vars=GOOGLE_CLOUD_PROJECT=${project}`, '--port=8080']);
  await setServiceLimits();
  gcloud(['run', 'jobs', 'deploy', job, `--image=${digest}`, `--region=${region}`, `--service-account=${account('healthcheck-sync')}`,
    '--command=node', '--args=dist/sync/cli.js,sync', '--tasks=1', '--parallelism=1', '--cpu=1', '--memory=512Mi',
    '--max-retries=0', '--task-timeout=540s',
    `--set-env-vars=GOOGLE_CLOUD_PROJECT=${project},GOOGLE_HEALTH_CREDENTIAL_SECRET=projects/${project}/secrets/${secret}/versions/latest`]);
  gcloud(['run', 'jobs', 'add-iam-policy-binding', job, `--region=${region}`,
    `--member=serviceAccount:${account('healthcheck-scheduler')}`, '--role=roles/run.invoker', '--format=none']);

  // ジョブ実行のHTTP受付成功と同期完了は別。初回同期の完了を待ってから定期起動を設定する。
  gcloud(['run', 'jobs', 'execute', job, `--region=${region}`, '--wait']);
  const schedules = json<{ name: string }[]>(['scheduler', 'jobs', 'list', `--location=${region}`]);
  const exists = schedules.some(item => item.name.endsWith(`/${scheduler}`));
  gcloud(['scheduler', 'jobs', exists ? 'update' : 'create', 'http', scheduler, `--location=${region}`, '--schedule=*/15 * * * *',
    '--time-zone=Asia/Tokyo', `--uri=https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}:run`,
    '--http-method=POST', exists ? '--update-headers=Content-Type=application/json' : '--headers=Content-Type=application/json',
    '--message-body={}', '--attempt-deadline=60s',
    '--max-retry-attempts=0', '--max-retry-duration=0s', `--oauth-service-account-email=${account('healthcheck-scheduler')}`,
    '--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform']);
  const url = gcloud(['run', 'services', 'describe', 'healthcheck', `--region=${region}`, '--format=value(status.url)'], true);
  console.log(`公開URL: ${url}\n定期同期: Asia/Tokyo、15分ごと（${scheduler}）`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Cloud設定に失敗しました。'); process.exitCode = 1; });
