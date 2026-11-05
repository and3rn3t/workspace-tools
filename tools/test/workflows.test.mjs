import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRepoCi, repoCiWorkflows } from '../lib/workflows.mjs';

const wf = (id, name, path, state = 'active') => ({ id, name, path, state });

test('Dependabot and other dynamic workflows are not repo CI', () => {
  assert.equal(isRepoCi(wf(1, 'Dependabot Updates', 'dynamic/dependabot/dependabot-updates')), false);
  assert.equal(isRepoCi(wf(2, 'Copilot', 'dynamic/copilot-swe-agent/copilot')), false);
});

test('active workflow files count; disabled ones do not', () => {
  assert.equal(isRepoCi(wf(3, 'CI', '.github/workflows/ci.yml')), true);
  assert.equal(isRepoCi(wf(4, 'Old', '.github/workflows/old.yml', 'disabled_manually')), false);
});

test('repoCiWorkflows maps id → name and tolerates a missing path', () => {
  const m = repoCiWorkflows([wf(1, 'CI', '.github/workflows/ci.yml'), wf(2, 'Dependabot Updates', 'dynamic/dependabot/dependabot-updates'), { id: 5, name: 'X', state: 'active' }]);
  assert.deepEqual([...m], [[1, 'CI'], [5, 'X']]);
});
