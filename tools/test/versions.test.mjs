import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sharedConfigs } from '../lib/versions.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

test('sharedConfigs is null without a root package.json', () => {
  assert.equal(sharedConfigs(fixtureRepo({ 'pyproject.toml': '' }).name), null);
});

test('sharedConfigs reports nothing adopted for a plain repo', () => {
  const r = fixtureRepo({ 'package.json': '{"devDependencies":{"eslint":"^10.0.0"}}', '.prettierrc': '{"semi":false}', 'tsconfig.json': '{}' });
  assert.deepEqual(sharedConfigs(r.name), { eslint: false, prettier: false, tsconfig: false, packageManager: null });
});

test('sharedConfigs detects each shared config and the package manager', () => {
  const pkg = { packageManager: 'pnpm@11.28.9', devDependencies: { '@and3rn3t/eslint-config': '^0.4.0' }, prettier: '@and3rn3t/eslint-config/prettier' };
  const r = fixtureRepo({ 'package.json': JSON.stringify(pkg), 'tsconfig.app.json': '{"extends":"@and3rn3t/eslint-config/tsconfig.json"}' });
  assert.deepEqual(sharedConfigs(r.name), { eslint: true, prettier: true, tsconfig: true, packageManager: 'pnpm@11.28.9' });
});

test('sharedConfigs detects a prettier.config.js that spreads the base', () => {
  const r = fixtureRepo({
    'package.json': '{}',
    'prettier.config.mjs': "import base from '@and3rn3t/eslint-config/prettier-tailwind'\nexport default { ...base, semi: false }\n",
  });
  assert.equal(sharedConfigs(r.name).prettier, true);
});

test('sharedConfigs skips the shared package itself', () => {
  assert.equal(sharedConfigs(fixtureRepo({ 'package.json': '{"name":"@and3rn3t/eslint-config"}' }).name), null);
});
