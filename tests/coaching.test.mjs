// 実行: node --test tennis-form/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, computeMetrics } from '../docs/js/pose-math.js';
import { evaluateServe, summarize, CHECKS, GUIDE } from '../docs/js/coaching.js';
import { near, figure, serveClip } from './helpers.mjs';

function evaluate(poses, edit) {
  const { frames, serve } = serveClip(poses);
  edit?.(frames, serve);
  const series = buildSeries(frames, 'right');
  const results = evaluateServe({ frames, series, serve });
  return { results, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

const GOOD = {
  trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 120 },
  impact: { raise: 1, elbow: 180, toss: 0.3, bend: 172 },
};

test('棒人間：トスの腕と肘の角度が指定どおりに測れる', () => {
  const m = computeMetrics(figure({ raise: 0.5, elbow: 90, toss: 0.9, bend: 120 }), 'right');
  near(m.shoulder, 90, 0.01, 'shoulder');
  near(m.elbow, 90, 0.01, 'elbow');
  near(m.toss, 162, 0.01, 'toss');
  near(m.kneeL, 120, 0.01, 'kneeL');
  // 左利きとして測ると、利き腕とトスの腕が入れ替わる
  const left = computeMetrics(figure({ raise: 0.5, toss: 0.9 }), 'left');
  near(left.shoulder, 162, 0.01, 'left shoulder');
  near(left.toss, 90, 0.01, 'left toss');
});

test('目安どおりのサーブは全項目が「良い」', () => {
  const { results } = evaluate(GOOD);
  assert.equal(results.length, CHECKS.length);
  for (const r of results) assert.equal(r.status, 'good', `${r.id}: ${r.valueText} ${r.text}`);
  assert.deepEqual(summarize(results), { measured: 6, good: 6, total: 6 });
});

test('測った値が項目ごとに合っている', () => {
  const { byId } = evaluate(GOOD);
  near(byId['trophy-knee'].value, 120, 3);
  near(byId['trophy-elbow'].value, 90, 3);
  near(byId['trophy-toss'].value, 162, 4);
  near(byId['impact-elbow'].value, 180, 3);
  near(byId['impact-knee'].value, 172, 3);
  assert.ok(byId['impact-reach'].value > 1.25, `reach ${byId['impact-reach'].value}`);
  assert.equal(byId['trophy-knee'].valueText, `${byId['trophy-knee'].value.toFixed(0)}°`);
  assert.match(byId['impact-reach'].valueText, /^\d\.\d\d倍$/);
  assert.equal(byId['trophy-knee'].momentLabel, 'トロフィーポーズ');
  assert.match(byId['impact-elbow'].momentLabel, /^インパクト（前後 0\.1 秒/);
});

test('崩れたサーブは全項目が「見直しポイント」になり、程度の強い文が出る', () => {
  const { results, byId } = evaluate({
    trophy: { raise: 0.25, elbow: 150, toss: 0.4, bend: 172 },
    impact: { raise: 0.8, elbow: 125, toss: 0.1, bend: 140 },
  });
  for (const r of results) assert.equal(r.status, 'hint', `${r.id}: ${r.valueText}`);
  assert.match(byId['trophy-knee'].text, /ほとんど伸びたまま/);
  assert.match(byId['trophy-elbow'].text, /肘が下がっています/);
  assert.match(byId['trophy-toss'].text, /早く下がっています/);
  assert.match(byId['impact-elbow'].text, /大きく曲がっています/);
  assert.match(byId['impact-reach'].text, /低/);
  assert.match(byId['impact-knee'].text, /曲がったまま/);
  assert.deepEqual(summarize(results), { measured: 6, good: 0, total: 6 });
});

test('少しだけ外れた場合は、程度の弱い文になる', () => {
  const { byId } = evaluate({
    trophy: { raise: 0.39, elbow: 90, toss: 0.9, bend: 150 },   // 肘の高さ 約 70°、膝 150°
    impact: { raise: 1, elbow: 150, toss: 0.3, bend: 172 },
  });
  assert.equal(byId['trophy-knee'].status, 'hint');
  assert.match(byId['trophy-knee'].text, /浅め/);
  assert.equal(byId['trophy-elbow'].status, 'hint');
  assert.match(byId['trophy-elbow'].text, /少し下がっています/);
  assert.equal(byId['impact-elbow'].status, 'hint');
  assert.match(byId['impact-elbow'].text, /少し曲がったまま/);
  assert.equal(byId['trophy-toss'].status, 'good');
});

test('境目の値は「良い」側に入る', () => {
  const knee = CHECKS.find((c) => c.id === 'trophy-knee');
  assert.equal(knee.judge(GUIDE.trophyKnee.good).status, 'good');
  assert.equal(knee.judge(GUIDE.trophyKnee.good + 0.1).status, 'hint');
  const elbow = CHECKS.find((c) => c.id === 'impact-elbow');
  assert.equal(elbow.judge(GUIDE.impactElbow.good).status, 'good');
  assert.equal(elbow.judge(GUIDE.impactElbow.good - 0.1).status, 'hint');
});

test('膝から下が映っていないと、膝と打点の高さは「測れず」', () => {
  const { results, byId } = evaluate({ trophy: { ...GOOD.trophy, legs: false }, impact: GOOD.impact });
  for (const id of ['trophy-knee', 'impact-knee', 'impact-reach']) {
    assert.equal(byId[id].status, 'na', id);
    assert.equal(byId[id].value, null);
    assert.equal(byId[id].valueText, '—');
    assert.match(byId[id].text, /測れませんでした/);
  }
  for (const id of ['trophy-elbow', 'trophy-toss', 'impact-elbow']) assert.equal(byId[id].status, 'good', id);
  assert.deepEqual(summarize(results), { measured: 3, good: 3, total: 6 });
});

test('トロフィーポーズが見つからないと、その 3 項目は理由つきで「測れず」', () => {
  const { byId } = evaluate(GOOD, (_frames, serve) => { serve.trophy = null; });
  for (const id of ['trophy-knee', 'trophy-elbow', 'trophy-toss']) {
    assert.equal(byId[id].status, 'na', id);
    assert.match(byId[id].text, /トロフィーポーズを見つけられなかった/);
  }
  assert.equal(byId['impact-elbow'].status, 'good');
});

test('インパクトのコマで腕を読み取れなくても、前後のコマの値で判定する', () => {
  const { byId } = evaluate(GOOD, (frames, serve) => { frames[serve.impact].pts = null; });
  assert.equal(byId['impact-elbow'].status, 'good');
  assert.ok(byId['impact-elbow'].value > 165, `elbow ${byId['impact-elbow'].value}`);
});

test('後ろ足を蹴り上げて曲げていても、伸びている側の膝で判定する', () => {
  const { byId } = evaluate(GOOD, (frames, serve) => {
    // インパクト前後で右足だけ曲げる（右膝を右足首の位置へ寄せて角度を小さくする）
    for (let i = serve.impact - 4; i <= serve.impact + 4; i++) {
      const p = frames[i].pts;
      p[28] = { x: p[26].x + 0.15, y: p[26].y, v: 1 };
    }
  });
  assert.equal(byId['impact-knee'].status, 'good');
});
