import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { marked } from 'marked';

const source = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = join(source, 'dist');
const origin = 'https://health.yt8492.com';
const template = await readFile(join(source, 'page.html'), 'utf8');
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function page({ title, description, path, content, root = './', kind = 'home' }) {
  const values = {
    TITLE: escapeHtml(title),
    DESCRIPTION: escapeHtml(description),
    CANONICAL: `${origin}${path}`,
    ROOT: root,
    KIND: kind,
    CONTENT: content,
  };
  return template.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown template field: ${key}`);
    return values[key];
  });
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(join(output, 'about'), { recursive: true });
await writeFile(join(output, 'about', 'index.html'), page({
  title: 'healthcheck — 健康の記録を、振り返る。',
  description: 'マヤミトが運営する、本人のFitbit心拍・睡眠・活動データをGoogle Health APIで取得・保存し、振り返りと公開に利用する個人サービス。',
  path: '/about/',
  root: '../',
  content: await readFile(join(source, 'home.html'), 'utf8'),
}));

for (const document of [
  { file: 'PRIVACY_POLICY.md', slug: 'privacy', title: 'プライバシーポリシー', description: 'healthcheckにおける健康データ、認証情報、アクセス情報の取得・利用・保存・公開と削除の方針。' },
  { file: 'TERMS_OF_SERVICE.md', slug: 'terms', title: '利用規約', description: 'healthcheckのウェブページと公開APIの利用条件。' },
]) {
  // The root Markdown files remain the source of truth; only their links change for the website.
  const markdown = (await readFile(join(repository, document.file), 'utf8'))
    .replace(/\]\((?:\.\/)?PRIVACY_POLICY\.md\)/g, '](../privacy/)')
    .replace(/\]\((?:\.\/)?TERMS_OF_SERVICE\.md\)/g, '](../terms/)');
  const content = marked.parse(markdown, { gfm: true, async: false });
  if (/href="(?:\.\/)?(?:PRIVACY_POLICY|TERMS_OF_SERVICE)\.md"/.test(content)) {
    throw new Error(`Unconverted legal document link: ${document.file}`);
  }
  await mkdir(join(output, document.slug), { recursive: true });
  await writeFile(join(output, document.slug, 'index.html'), page({
    title: `${document.title} | healthcheck`,
    description: document.description,
    path: `/${document.slug}/`,
    root: '../',
    kind: 'legal',
    content: `<article class="legal-document">${content}</article>`,
  }));
}

// Explicit allowlist: application source, local credentials, and health data are never copied.
for (const asset of ['styles.css', 'favicon.svg']) {
  await copyFile(join(source, asset), join(output, asset));
}
await writeFile(join(output, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
await writeFile(join(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/about/', '/privacy/', '/terms/'].map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n')}\n</urlset>\n`);
console.log('Built introduction, privacy policy, and terms in site/dist.');
