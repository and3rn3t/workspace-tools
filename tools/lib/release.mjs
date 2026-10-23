// Release-train logic, pure: next version from conventional commits, release
// notes, and the CHANGELOG.md section. tools/release-train.mjs does the IO.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
export const parseSemver = tag => { const m = String(tag).match(SEMVER); return m ? m.slice(1, 4).map(Number) : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// Highest plain x.y.z tag among published releases (pre-release and odd tags like
// "prod-rollback-2025-09-12" don't count as a base).
export function baseRelease(releases) {
  return releases.filter(r => !r.draft && !r.prerelease && parseSemver(r.tag_name))
    .sort((a, b) => cmp(parseSemver(b.tag_name), parseSemver(a.tag_name)))[0] ?? null;
}

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const BOT = /renovate|dependabot|github-actions|\[bot\]/i;

// { type, scope, breaking, subject, worthy } — worthy = changes users get: feat,
// fix, perf, revert, anything breaking. chore/ci/docs/test/style/build/refactor
// and dependency bumps alone don't make a release (fix(deps) does: security).
export function classifyCommit({ subject, body = '', author = '' }) {
  const m = subject.match(HEADER);
  const type = m ? m[1].toLowerCase() : 'other';
  const scope = m?.[2] ?? null;
  const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
  const bot = BOT.test(author);
  const worthy = breaking || ['feat', 'perf', 'revert'].includes(type) || (type === 'fix' && (!bot || scope === 'deps'));
  return { type, scope, breaking, subject: m ? m[4] : subject, raw: subject, worthy, bot };
}

// Next version: breaking → major (minor while 0.x), feat → minor, else patch.
// No base → the declared version when it's a real one, else 0.1.0.
export function nextVersion(base, commits, declared = null) {
  if (!base) { const d = parseSemver(declared ?? ''); return d && cmp(d, [0, 0, 0]) > 0 ? d.join('.') : '0.1.0'; }
  const [maj, min, pat] = parseSemver(base);
  const cs = commits.map(classifyCommit);
  if (cs.some(c => c.breaking)) return maj === 0 ? `0.${min + 1}.0` : `${maj + 1}.0.0`;
  if (cs.some(c => c.type === 'feat')) return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const SECTIONS = [['Breaking changes', c => c.breaking], ['Features', c => c.type === 'feat'], ['Fixes', c => c.type === 'fix' || c.type === 'perf' || c.type === 'revert']];

// Markdown notes from the release-worthy commits ("- subject (#12)"); other
// commits are summarised in one line.
export function renderNotes(commits) {
  const cs = commits.map(classifyCommit);
  const used = new Set();
  const out = [];
  for (const [title, pick] of SECTIONS) {
    const rows = cs.filter(c => !used.has(c) && c.worthy && pick(c));
    if (!rows.length) continue;
    rows.forEach(c => used.add(c));
    out.push(`### ${title}`, '', ...rows.map(c => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`), '');
  }
  const rest = cs.filter(c => !used.has(c));
  if (rest.length) out.push(`Plus ${rest.length} maintenance commit(s) (dependencies, CI, docs, refactors).`, '');
  return out.join('\n').trim() + '\n';
}

// CHANGELOG.md text with a "## [x.y.z] - date" section. Keep a Changelog files
// get their "## [Unreleased]" content moved under the new heading (Unreleased
// stays, empty); others get the generated notes inserted above the first "## ".
export function changelogWithRelease(text, version, date, notes) {
  if (changelogHas(text, version)) return text;
  const heading = `## [${version}] - ${date}`;
  const unreleased = text.match(/^## \[Unreleased\][^\n]*\n/m);
  if (unreleased) {
    const start = unreleased.index + unreleased[0].length;
    const next = text.slice(start).search(/^## /m);
    const body = (next === -1 ? text.slice(start) : text.slice(start, start + next)).trim();
    const tail = next === -1 ? '' : text.slice(start + next);
    return `${text.slice(0, start)}\n${heading}\n\n${body || notes.trim()}\n\n${tail}`.replace(/\n{3,}/g, '\n\n');
  }
  const first = text.search(/^## /m);
  const section = `${heading}\n\n${notes.trim()}\n\n`;
  return first === -1 ? `${text.trimEnd()}\n\n${section}` : text.slice(0, first) + section + text.slice(first);
}

// Does the changelog already document this version?
export const changelogHas = (text, version) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm').test(text);
