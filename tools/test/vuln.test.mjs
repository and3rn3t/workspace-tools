import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, inRange, lockfileVersions, stillVulnerable } from '../lib/vuln.mjs';

test('compare: numeric, missing parts are 0, pre-release ignored', () => {
  assert.equal(compare('1.10.0', '1.9.9'), 1);
  assert.equal(compare('2', '2.0.0'), 0);
  assert.equal(compare('0.9.12-beta.1', '0.9.12'), 0);
  assert.equal(compare('v3.1.5', '3.1.6'), -1);
});

test('inRange: GitHub vulnerable_version_range forms', () => {
  assert.ok(inRange('0.9.11', '>= 0.9.0, < 0.9.12'));
  assert.ok(!inRange('0.9.12', '>= 0.9.0, < 0.9.12'));
  assert.ok(!inRange('0.8.20', '>= 0.9.0, < 0.9.12'));
  assert.ok(inRange('3.1.5', '< 3.1.6'));
  assert.ok(inRange('1.2.3', '= 1.2.3'));
  assert.ok(inRange('4.0.0', '<= 4.0.0'));
});

test('lockfileVersions: npm v3 keeps nested copies, skips root and links', () => {
  const lock = JSON.stringify({ packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/undici': { version: '7.27.0' },
    'node_modules/vite/node_modules/rollup': { version: '4.58.0' },
    'node_modules/rollup': { version: '4.60.0' },
    'node_modules/@xmldom/xmldom': { version: '0.9.10' },
    'node_modules/local-pkg': { resolved: 'packages/x', link: true },
  } });
  const v = lockfileVersions(lock, 'npm');
  assert.deepEqual([...v.get('rollup')].sort(), ['4.58.0', '4.60.0']);
  assert.deepEqual([...v.get('@xmldom/xmldom')], ['0.9.10']);
  assert.ok(!v.has('local-pkg') && !v.has('app'));
  assert.deepEqual(stillVulnerable(v, 'rollup', '< 4.59.0'), ['4.58.0']);
});

test('lockfileVersions: pnpm v6 and v9 keys, peer suffixes stripped', () => {
  const lock = [
    'packages:', '',
    '  /fast-uri@3.1.0:', '    resolution: {integrity: sha512-x}', '',
    "  '@xmldom/xmldom@0.8.10':", '    resolution: {integrity: sha512-y}', '',
    'snapshots:', '',
    "  '@vitejs/plugin-react@5.0.0(vite@7.1.0)':", '    dependencies:', '      vite: 7.1.0', '',
    '  undici@7.28.0: {}',
  ].join('\n');
  const v = lockfileVersions(lock, 'pnpm');
  assert.deepEqual([...v.get('fast-uri')], ['3.1.0']);
  assert.deepEqual([...v.get('@xmldom/xmldom')], ['0.8.10']);
  assert.deepEqual([...v.get('@vitejs/plugin-react')], ['5.0.0']);
  assert.deepEqual([...v.get('undici')], ['7.28.0']);
  assert.ok(!v.has('vite'), 'nested dependency lines are not package keys');
});
