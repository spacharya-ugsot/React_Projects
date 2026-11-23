// Builds every project listed in projects.json into ./site/<name>/.
// A project whose source folder hasn't changed since the last deploy is reused, not rebuilt.
// A project that fails to build keeps serving its previous version.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const SITE = path.join(ROOT, 'site');
const NEXT = path.join(ROOT, '.site-next');
const WORK = path.join(ROOT, '.work');
const TOKEN = process.env.SOURCE_TOKEN || '';

const hide = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
const quiet = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const has = (...p) => fs.existsSync(path.join(...p));

const projects = readJSON(path.join(ROOT, 'projects.json'), []);
const previous = readJSON(path.join(SITE, 'status.json'), {}).projects || {};

for (const d of [NEXT, WORK]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}

function parseLink(url) {
  const m = String(url).trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  if (!m) throw new Error(`Not a GitHub folder link: ${url}`);
  const dir = m[4].split('/').map((s) => decodeURIComponent(s)).join('/');
  return { owner: m[1], repo: m[2], ref: m[3], dir };
}

const checkouts = new Map();
function checkout(src) {
  const key = `${src.owner}/${src.repo}@${src.ref}`;
  if (checkouts.has(key)) return checkouts.get(key);
  const dir = path.join(WORK, `src${checkouts.size}`);
  fs.mkdirSync(dir);
  const auth = TOKEN ? `x-access-token:${TOKEN}@` : '';
  quiet('git init -q', dir);
  quiet(`git remote add origin https://${auth}github.com/${src.owner}/${src.repo}.git`, dir);
  quiet(`git fetch -q --depth 1 origin ${src.ref}`, dir); // works for branches and commit SHAs
  quiet('git checkout -q FETCH_HEAD', dir);
  checkouts.set(key, dir);
  return dir;
}

function findApp(base) {
  for (const sub of ['', 'frontend', 'client']) {
    if (has(base, sub, 'package.json')) return path.join(base, sub);
  }
  throw new Error('No package.json found in the project folder');
}

function build(app, name) {
  const outDir = path.join(NEXT, name);
  if (has(app, 'package-lock.json')) {
    try { run('npm ci --no-audit --no-fund', app); } catch { run('npm install --no-audit --no-fund', app); }
  } else {
    run('npm install --no-audit --no-fund', app);
  }
  if (process.env.PROJECT_ENV) fs.writeFileSync(path.join(app, '.env.production.local'), process.env.PROJECT_ENV + '\n');
  run(`npx vite build --base=/${name}/ --outDir "${outDir}" --emptyOutDir`, app);
  if (!has(outDir, 'index.html')) throw new Error('Build finished but produced no index.html');
}

const status = {};
for (const p of projects) {
  const name = p.name;
  const entry = { source: p.source, group: p.group || 'React Projects', title: p.title || '', ok: false };
  console.log(`\n=== ${name} ===`);
  try {
    const src = parseLink(p.source);
    const repoDir = checkout(src);
    entry.tree = quiet(`git rev-parse "HEAD:${src.dir}"`, repoDir);
    const prev = previous[name];
    if (prev && prev.ok && prev.tree === entry.tree && prev.source === p.source && has(SITE, name, 'index.html')) {
      fs.cpSync(path.join(SITE, name), path.join(NEXT, name), { recursive: true });
      entry.builtAt = prev.builtAt;
      console.log('Unchanged, reusing previous build');
    } else {
      build(findApp(path.join(repoDir, src.dir)), name);
      entry.builtAt = new Date().toISOString();
    }
    entry.ok = true;
  } catch (err) {
    entry.error = hide(err.message || err).split('\n')[0].slice(0, 300);
    console.log(`::warning::${name} failed: ${entry.error}`);
    if (has(SITE, name, 'index.html')) {
      fs.rmSync(path.join(NEXT, name), { recursive: true, force: true });
      fs.cpSync(path.join(SITE, name), path.join(NEXT, name), { recursive: true });
      entry.servingPrevious = true;
    }
  }
  status[name] = entry;
}

const live = Object.keys(status).filter((n) => has(NEXT, n, 'index.html'));
const rewrites = live.map((n) => ({ source: `/${n}/(.*)`, destination: `/${n}/index.html` }));
const pretty = (n) => n.toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (g) => (/full.?stack/i.test(g) ? 'full-stack' : g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

const groups = [];
for (const [n, s] of Object.entries(status)) {
  let g = groups.find((x) => x.name === s.group);
  if (!g) groups.push((g = { name: s.group, slug: slug(s.group), items: [] }));
  g.items.push([n, s]);
}

const card = ([n, s], prefix) => {
  const state = s.ok ? '' : s.servingPrevious ? '<span class="warn">Last build failed, showing previous version</span>' : '<span class="err">Build failed</span>';
  const inner = `<span class="name">${esc(s.title || pretty(n))}</span><span class="path">/${esc(n)}/</span>${state}`;
  return live.includes(n) ? `<a class="card" href="${prefix}${esc(n)}/">${inner}</a>` : `<div class="card off">${inner}</div>`;
};

const page = (title, subtitle, body, back) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    :root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#6b7280;--accent:#2563eb;--border:#e5e7eb;--warn:#b45309;--err:#b91c1c}
    @media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b22;--text:#e6e8ec;--muted:#9aa1ad;--accent:#60a5fa;--border:#2a2f3a;--warn:#fbbf24;--err:#f87171}}
    *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
    .wrap{max-width:1100px;margin:0 auto;padding:0 16px}header{padding:48px 0 8px}h1{margin:0 0 8px;font-size:2rem}h2{margin:32px 0 4px;font-size:1.25rem}
    p{margin:0;color:var(--muted)}a.back{display:inline-block;margin-bottom:12px;color:var(--accent);text-decoration:none;font-size:.9rem}h2 a{color:inherit;text-decoration:none}h2 a:hover{color:var(--accent)}
    .grid{padding:16px 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
    .card{display:flex;flex-direction:column;gap:6px;padding:18px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:inherit;text-decoration:none;transition:border-color .15s,transform .15s}
    a.card:hover{border-color:var(--accent);transform:translateY(-2px)}.off{opacity:.6}
    .name{font-weight:600}.path{font-size:.85rem;color:var(--muted);word-break:break-all}.warn{font-size:.8rem;color:var(--warn)}.err{font-size:.8rem;color:var(--err)}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      ${back ? '<a class="back" href="../">&larr; All React projects</a>' : ''}
      <h1>${esc(title)}</h1>
      <p>${esc(subtitle)}</p>
    </header>
    ${body}
  </div>
</body>
</html>
`;

const liveCount = (items) => items.filter(([n]) => live.includes(n)).length;
const rootBody = groups.map((g) => `<h2><a href="./${esc(g.slug)}/">${esc(g.name)}</a></h2>
    <p>${liveCount(g.items)} live</p>
    <div class="grid">
      ${g.items.map((it) => card(it, './')).join('\n      ')}
    </div>`).join('\n    ');
fs.writeFileSync(path.join(NEXT, 'index.html'), page('React Projects', `${live.length} live React projects. Click any card to open it.`, rootBody, false));

for (const g of groups) {
  fs.mkdirSync(path.join(NEXT, g.slug), { recursive: true });
  const body = `<div class="grid">
      ${g.items.map((it) => card(it, '../')).join('\n      ')}
    </div>`;
  fs.writeFileSync(path.join(NEXT, g.slug, 'index.html'), page(g.name, `${liveCount(g.items)} live projects. Click any card to open it.`, body, true));
}

fs.writeFileSync(path.join(NEXT, 'status.json'), JSON.stringify({ projects: status }, null, 2) + '\n');
fs.writeFileSync(path.join(NEXT, 'vercel.json'), JSON.stringify({ rewrites }, null, 2) + '\n');
fs.rmSync(SITE, { recursive: true, force: true });
fs.renameSync(NEXT, SITE);
fs.rmSync(WORK, { recursive: true, force: true });

const failed = Object.entries(status).filter(([, s]) => !s.ok).map(([n]) => n);
console.log(`\nLive: ${live.length}/${projects.length}${failed.length ? `  Failed: ${failed.join(', ')}` : ''}`);
