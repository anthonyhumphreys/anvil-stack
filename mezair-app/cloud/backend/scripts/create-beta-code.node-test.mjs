import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./create-beta-code.mjs', import.meta.url);
test('emits a random beta code and SQL containing only its domain-separated hash', () => {
  const args = ['--redeem-until', '2060-01-01T00:00:00Z', '--access-until', '2060-02-01T00:00:00Z'];
  const first = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  const result = JSON.parse(first.stdout);
  assert.match(result.code, /^mezair_beta_[a-f0-9]{32}$/);
  assert.notEqual(result.code, JSON.parse(second.stdout).code);
  const hash = createHash('sha256').update(`mezair/beta-code/v1:${result.code}`).digest('hex');
  assert.ok(result.sql.includes(hash));
  assert.ok(!result.sql.includes(result.code));
});
test('requires explicit future redemption and access deadlines in order', () => {
  for (const args of [[], ['--redeem-until', '2000-01-01'],
    ['--redeem-until', '2060-02-01', '--access-until', '2060-01-01']]) {
    assert.notEqual(spawnSync(process.execPath, [script.pathname, ...args]).status, 0);
  }
});
