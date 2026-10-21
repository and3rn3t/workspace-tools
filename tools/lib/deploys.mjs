// Deploy targets declared in each repo's wrangler config (wrangler.toml / .json /
// .jsonc, up to 2 directories deep). A light parser: only the top-level fields an
// inventory needs, not a full TOML implementation.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './manifest.mjs';

function wranglerFiles(dir, depth = 2, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isFile() && /^wrangler\.(toml|json|jsonc)$/.test(e.name)) out.push(join(dir, e.name));
    else if (depth > 0 && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist') wranglerFiles(join(dir, e.name), depth - 1, out);
  }
  return out;
}

// Top-level keys of a TOML file only (stops at the first [table] header).
function parseToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*(#.*)?$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (/^\s*\[assets\]/m.test(text)) out.assets = true;
  // Routes / custom domains anywhere in the file.
  out.routes = [...text.matchAll(/pattern\s*=\s*["']([^"']+)["']/g)].map(r => r[1]);
  const route = text.match(/^\s*route\s*=\s*["']([^"']+)["']/m);
  if (route) out.routes.push(route[1]);
  return out;
}

const parseJsonc = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1'));

export function repoDeploys(repo) {
  const repoPath = join(ROOT, repo);
  if (!existsSync(repoPath)) return [];
  return wranglerFiles(repoPath).flatMap(file => {
    let cfg;
    try { cfg = file.endsWith('.toml') ? parseToml(readFileSync(file, 'utf8')) : parseJsonc(readFileSync(file, 'utf8')); }
    catch { return [{ repo, file: relative(repoPath, file), name: null, kind: 'unparseable', routes: '' }]; }
    const routes = cfg.routes ?? (cfg.route ? [cfg.route] : []);
    const routeList = (Array.isArray(routes) ? routes : [routes]).map(r => (typeof r === 'string' ? r : r?.pattern)).filter(Boolean);
    return [{
      repo,
      file: relative(repoPath, file),
      name: cfg.name ?? null,
      kind: cfg.pages_build_output_dir ? 'pages' : cfg.main ? 'worker' : cfg.assets ? 'worker (static assets)' : 'unknown',
      routes: routeList.join(' '),
      // Template leftovers: a placeholder project name or an example domain in a route.
      placeholder: /REPLACE/i.test(cfg.name ?? '') || routeList.some(r => /yourdomain|example\.(com|org)/i.test(r)),
    }];
  });
}
