// 2 本のサーブの違いを並べる計算と、骨格を重ねるための姿勢のそろえ方のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, standardPose, facingDirection, LM } from '../docs/js/pose-math.js';
import { evaluateServe, compareServes, DIFF_SCALE } from '../docs/js/coaching.js';
import { near, serveClip } from './helpers.mjs';

function results(poses, view = 'back') {
  const { frames, serve } = serveClip(poses);
  return evaluateServe({ frames, series: buildSeries(frames, 'right'), serve, view, hand: 'right' });
}

const FLAT = { trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 105 }, impact: { raise: 1, elbow: 178, toss: 0.3, bend: 172 } };
const SPIN = { trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 92 }, impact: { raise: 0.93, elbow: 150, toss: 0.3, bend: 172 } };

test('違いの大きい順に並び、はっきり違う項目だけ一言が付く', () => {
  const rows = compareServes(results(FLAT), results(SPIN), 'back');
  assert.ok(rows.length >= 5);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score, '大きい順');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  const elbow = byId['impact-elbow'];           // 178° → 150°
  assert.equal(elbow.notable, true);
  near(elbow.diff, -28, 4);
  assert.match(elbow.diffText, /^−\d+°$/);
  assert.equal(elbow.text, 'A のほうが肘が伸びています。');

  const knee = byId['trophy-knee'];             // 105° → 92°
  assert.equal(knee.notable, true);
  assert.equal(knee.text, 'B のほうが膝を深く曲げています。');

  const toss = byId['trophy-toss'];             // 同じ
  assert.equal(toss.notable, false);
  assert.equal(toss.text, 'ほぼ同じです。');
  assert.match(toss.diffText, /^±0°$/);
  assert.equal(rows[rows.length - 1].notable, false);
});

test('同じサーブどうしなら、はっきり違う項目は 0', () => {
  const rows = compareServes(results(FLAT), results(FLAT), 'side');
  assert.ok(rows.length > 0);
  assert.equal(rows.filter((r) => r.notable).length, 0);
});

test('片方で測れなかった項目は比べない', () => {
  const noLegs = { trophy: { ...FLAT.trophy, legs: false }, impact: FLAT.impact };
  const rows = compareServes(results(FLAT), results(noLegs), 'back');
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes('trophy-knee') && !ids.includes('impact-knee') && !ids.includes('impact-reach'));
  assert.ok(ids.includes('impact-elbow'));
});

test('打点の位置は、向きに応じた言い方になる。差は丸めた数字どうしで出す', () => {
  const item = (value) => [{ id: 'impact-contact', title: '打点の位置', momentLabel: 'インパクト', unit: '%', digits: 0, value, valueText: `${value.toFixed(0)}%` }];
  const fwd = compareServes(item(12.4), item(3.6), 'side')[0];   // 12% → 4%
  assert.equal(fwd.diff, -8);
  assert.equal(fwd.diffText, '−8%');
  assert.equal(fwd.text, 'B のほうが後ろ（頭の真上寄り）で打っています。');
  assert.equal(compareServes(item(3.6), item(12.4), 'side')[0].text, 'B のほうが前（ネット側）で打っています。');
  assert.equal(compareServes(item(18), item(6), 'back')[0].text, 'B のほうが頭の真上寄り（反対側）で打っています。');
  assert.equal(compareServes(item(6), item(18), 'back')[0].text, 'B のほうが利き腕側で打っています。');
  const small = compareServes(item(10.4), item(13.6), 'side')[0]; // 10% → 14%：5% 未満
  assert.equal(small.notable, false);
  assert.equal(small.diffText, '+4%');
  assert.deepEqual(DIFF_SCALE, { '°': 10, '倍': 0.05, '%': 5 });
});

// 姿勢をそろえる
function pose({ noseX = 0.55, ankleX = 0.5, wristX = 0.62, scale = 1, shift = 0, mirror = false }) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0 }));
  const put = (i, x, y) => { const xs = shift + x * scale; pts[i] = { x: mirror ? 1 - xs : xs, y: y * scale, v: 1 }; };
  put(LM.NOSE, noseX, 0.2);
  put(LM.L_ANKLE, ankleX - 0.03, 0.9); put(LM.R_ANKLE, ankleX + 0.03, 0.9);
  put(LM.R_SHOULDER, 0.58, 0.3); put(LM.L_SHOULDER, 0.46, 0.3);
  put(LM.R_WRIST, wristX, 0.02);
  return pts;
}

test('standardPose: 足元が原点、鼻の高さが -1、前が右になる。大きさ・位置・左右反転によらない', () => {
  const base = standardPose(pose({}), 'right', 'side');
  near(base[LM.NOSE].y, -1, 1e-9);
  near((base[LM.L_ANKLE].x + base[LM.R_ANKLE].x) / 2, 0, 1e-9);
  near(base[LM.L_ANKLE].y, 0, 1e-9);
  assert.ok(base[LM.NOSE].x > 0, '頭は前（右）');
  near(base[LM.R_WRIST].x, (0.62 - 0.5) / 0.7, 1e-9);
  near(base[LM.R_WRIST].y, (0.02 - 0.9) / 0.7, 1e-9);

  for (const variant of [{ scale: 0.5 }, { shift: 0.2 }, { mirror: true }, { scale: 1.6, shift: -0.1, mirror: true }]) {
    const other = standardPose(pose(variant), 'right', 'side');
    for (const i of [LM.NOSE, LM.R_WRIST, LM.R_SHOULDER, LM.L_ANKLE]) {
      near(other[i].x, base[i].x, 1e-9, `x ${JSON.stringify(variant)} ${i}`);
      near(other[i].y, base[i].y, 1e-9, `y ${JSON.stringify(variant)} ${i}`);
    }
  }
});

test('standardPose / facingDirection: 後ろからは打つ側の肩が右。そろえられないときは null', () => {
  assert.equal(facingDirection(pose({}), 'right', 'back'), 1);
  assert.equal(facingDirection(pose({ mirror: true }), 'right', 'back'), -1);
  assert.equal(facingDirection(pose({}), 'left', 'back'), -1);
  const back = standardPose(pose({ mirror: true }), 'right', 'back');
  assert.ok(back[LM.R_SHOULDER].x > back[LM.L_SHOULDER].x, '打つ側の肩が右');

  assert.equal(standardPose(pose({ noseX: 0.5 }), 'right', 'side'), null, '頭が足の真上だと前後を決められない');
  const noAnkles = pose({});
  noAnkles[LM.L_ANKLE].v = 0; noAnkles[LM.R_ANKLE].v = 0;
  assert.equal(standardPose(noAnkles, 'right', 'side'), null);
  assert.equal(standardPose(null, 'right', 'side'), null);
  assert.equal(facingDirection(null, 'right', 'side'), 0);
});
