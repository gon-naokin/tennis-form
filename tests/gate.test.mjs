// 入口のパスワード：画面側の計算と、設定の道具の計算が一致することを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive } from '../docs/js/gate.js';
import { PASSWORD } from '../docs/js/config.js';
import { deriveSync, configSource } from '../tools/set-password.mjs';

test('画面側（Web Crypto）と道具側（Node）で、同じパスワードから同じ値が出る', async () => {
  for (const [password, salt] of [['tennis-2026', 'a1b2c3'], ['てにす部のあいことば', '00ff'], ['x'.repeat(40), 'salt']]) {
    assert.equal(await derive(password, salt, 1000), deriveSync(password, salt, 1000));
  }
});

test('パスワードや salt が 1 文字違えば、別の値になる', async () => {
  const base = await derive('tennis-2026', 'salt', 1000);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(await derive('tennis-2027', 'salt', 1000), base);
  assert.notEqual(await derive('tennis-2026', 'salu', 1000), base);
  assert.notEqual(await derive('Tennis-2026', 'salt', 1000), base);
});

test('見た目が同じ文字（濁点の合成のしかたの違い）は同じパスワードとして扱う', async () => {
  const composed = 'が', decomposed = 'が';
  assert.notEqual(composed, decomposed);
  assert.equal(await derive(composed, 's', 1000), await derive(decomposed, 's', 1000));
  assert.equal(deriveSync(composed, 's', 1000), deriveSync(decomposed, 's', 1000));
});

test('configSource: パスワードそのものは書かず、照合用の値だけを書く', async () => {
  const source = configSource('himitsu-no-kotoba', 'abcdef');
  assert.ok(!source.includes('himitsu'));
  const salt = /salt: '([^']*)'/.exec(source)[1];
  const hash = /hash: '([^']*)'/.exec(source)[1];
  const iterations = Number(/iterations: (\d+)/.exec(source)[1]);
  assert.equal(salt, 'abcdef');
  assert.equal(iterations, 200000);
  assert.equal(hash, await derive('himitsu-no-kotoba', salt, iterations));

  const cleared = configSource('');
  assert.match(cleared, /salt: ''/);
  assert.match(cleared, /hash: ''/);
});

test('同梱の config.js は読める形になっている', () => {
  assert.equal(typeof PASSWORD.salt, 'string');
  assert.equal(typeof PASSWORD.hash, 'string');
  assert.ok(PASSWORD.iterations >= 100000);
  assert.ok(PASSWORD.hash === '' || /^[0-9a-f]{64}$/.test(PASSWORD.hash));
});
