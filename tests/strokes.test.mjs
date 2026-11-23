// サーブ以外のショット（フォアハンド・バックハンド・ボレー・スマッシュ）の検出とチェックのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeries, findStrokes, strokeAt, strokeOffset, swingDirection, wristSpeed, bodyHeight, findServes, LM,
} from '../docs/js/pose-math.js';
import { evaluateServe, checksFor, momentNames, compareServes, SHOTS, CHECKS } from '../docs/js/coaching.js';
import { near, figure, serveClip } from './helpers.mjs';

// 右利きの人を真横から見たスイング。腕の向き level は -0.5 = 真後ろ、0 = 真下、0.5 = 真正面。
// back まで引いてから、加速しながら front まで振る（いちばん速いのは振り終わり = 打点）。
function swingClip({ back = -0.4, front = 0.5, bend = 140, at = [1.5], seconds = 3, fps = 30, mirror = false, legs = true } = {}) {
  const frames = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    let level = 0.05, knee = 172;
    for (const hit of at) {
      const d = t - hit;                       // 打点からの時間
      if (d >= -0.7 && d < -0.3) { level = 0.05 + (back - 0.05) * ((d + 0.7) / 0.4); knee = 172 + (bend - 172) * ((d + 0.7) / 0.4); }
      else if (d >= -0.3 && d < -0.25) { level = back; knee = bend; }
      else if (d >= -0.25 && d <= 0) { const u = (d + 0.25) / 0.25; level = back + (front - back) * u * u; knee = bend; }
      else if (d > 0 && d < 0.5) { level = front + (0.05 - front) * (d / 0.5); knee = bend + (172 - bend) * (d / 0.5); }
    }
    let pts = figure({ raise: level, bend: knee, legs });
    if (mirror) pts = pts.map((p) => ({ ...p, x: 1 - p.x }));
    frames.push({ t, pts });
  }
  return frames;
}

function evaluate(frames, shot, view = 'side') {
  const strokes = findStrokes(frames, 'right');
  const series = buildSeries(frames, 'right');
  const results = evaluateServe({ frames, series, serve: strokes[0], view, hand: 'right', shot });
  return { strokes, results, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

test('findStrokes: 1 回のスイングを見つけ、インパクトは振り終わり、テイクバックはいちばん引いた所', () => {
  const frames = swingClip();
  const strokes = findStrokes(frames, 'right');
  assert.equal(strokes.length, 1);
  near(frames[strokes[0].impact].t, 1.5, 0.07, 'impact');
  const prepT = frames[strokes[0].trophy].t;
  assert.ok(prepT >= 1.15 && prepT <= 1.3, `prep ${prepT}`);
  assert.equal(strokes[0].manual, false);
});

test('findStrokes: 2 球あれば 2 つ。腕を振らない動画では 0', () => {
  const two = findStrokes(swingClip({ at: [1.2, 3.0], seconds: 4 }), 'right');
  assert.equal(two.length, 2);
  assert.equal(findStrokes(swingClip({ at: [] }), 'right').length, 0);
});

test('findStrokes: 頭上に腕を上げないので、サーブの探し方では見つからない（逆も確認）', () => {
  assert.equal(findServes(swingClip(), 'right').length, 0);
  const { frames } = serveClip({ trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 110 }, impact: { raise: 1, elbow: 178, toss: 0.3, bend: 172 } });
  assert.equal(findServes(frames, 'right').length, 1);
});

test('左右を反転した映像でも、同じ結果になる', () => {
  const a = evaluate(swingClip(), 'forehand');
  const b = evaluate(swingClip({ mirror: true }), 'forehand');
  assert.equal(swingDirection(swingClip(), 'right', a.strokes[0].impact), 1);
  assert.equal(swingDirection(swingClip({ mirror: true }), 'right', b.strokes[0].impact), -1);
  assert.equal(a.strokes[0].impact, b.strokes[0].impact);
  near(a.byId['impact-front'].value, b.byId['impact-front'].value, 1e-6);
});

test('フォアハンド：前で打てば「良い」、体の近くや後ろなら「見直し」', () => {
  const good = evaluate(swingClip({ front: 0.5 }), 'forehand').byId;
  assert.equal(good['impact-front'].status, 'good');
  assert.ok(good['impact-front'].value > 30, `front ${good['impact-front'].value}`);
  assert.equal(good['prep-knee'].status, 'good');
  near(good['prep-knee'].value, 140, 4);
  assert.equal(good['impact-elbow-info'].status, 'info');

  // 境目は判定の関数で直接確かめる（インパクトのコマは 1 コマ前後するので、動画からだと境目がぶれる）
  const front = checksFor('forehand').find((c) => c.id === 'impact-front');
  assert.equal(front.judge(10).status, 'good');
  assert.match(front.judge(5).text, /体に近め/);
  assert.match(front.judge(-1).text, /体より後ろ/);

  const behind = evaluate(swingClip({ front: -0.1 }), 'forehand').byId['impact-front'];
  assert.equal(behind.status, 'hint');
  assert.match(behind.text, /体より後ろ/);

  const stiff = evaluate(swingClip({ bend: 170 }), 'forehand').byId['prep-knee'];
  assert.equal(stiff.status, 'hint');
  assert.match(stiff.text, /ほとんど伸びたまま/);
});

test('場面の名前：ストロークは「テイクバック」、サーブ・スマッシュは「トロフィーポーズ」', () => {
  assert.equal(momentNames('forehand').trophy, 'テイクバック');
  assert.equal(momentNames('volley').trophy, 'テイクバック');
  assert.equal(momentNames('serve').trophy, 'トロフィーポーズ');
  assert.equal(momentNames('smash').trophy, 'トロフィーポーズ');
  const { byId } = evaluate(swingClip(), 'backhand');
  assert.equal(byId['prep-knee'].momentLabel, 'テイクバック');
  assert.equal(byId['impact-front'].momentLabel, 'インパクト');
  assert.deepEqual(Object.keys(SHOTS), ['serve', 'smash', 'forehand', 'backhand', 'volley']);
});

test('後ろから撮った動画では、前後の位置は「測れず」になり理由を出す', () => {
  const { byId } = evaluate(swingClip(), 'forehand', 'back');
  assert.equal(byId['impact-front'].status, 'na');
  assert.match(byId['impact-front'].text, /真横から撮った動画で測れます/);
  assert.equal(byId['prep-knee'].status, 'good'); // 膝は向きによらず測る
});

test('ボレー：引きすぎは「見直し」、コンパクトなら「良い」。膝も見る', () => {
  const big = evaluate(swingClip({ back: -0.4, front: 0.35, bend: 150 }), 'volley').byId;
  assert.equal(big['prep-compact'].status, 'hint');
  assert.ok(big['prep-compact'].value < -20, `prep ${big['prep-compact'].value}`);
  assert.equal(big['impact-front'].status, 'good');
  assert.equal(big['impact-knee-bend'].status, 'good');

  const compact = evaluate(swingClip({ back: -0.03, front: 0.35, bend: 150 }), 'volley').byId;
  assert.equal(compact['prep-compact'].status, 'good');

  const upright = evaluate(swingClip({ back: -0.03, front: 0.35, bend: 172 }), 'volley').byId;
  assert.equal(upright['impact-knee-bend'].status, 'hint');
});

test('スマッシュ：サーブの項目のうち 4 つを使う', () => {
  const ids = checksFor('smash').map((c) => c.id);
  assert.deepEqual(ids, ['trophy-toss', 'impact-elbow', 'impact-reach', 'impact-contact']);
  assert.equal(checksFor('serve'), CHECKS);
  assert.equal(checksFor('forehand'), checksFor('backhand'));
  const { frames, serve } = serveClip({ trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 110 }, impact: { raise: 1, elbow: 178, toss: 0.3, bend: 172 } });
  const results = evaluateServe({ frames, series: buildSeries(frames, 'right'), serve, shot: 'smash', view: 'back' });
  assert.equal(results.length, 4);
  assert.equal(results.find((r) => r.id === 'impact-elbow').status, 'good');
});

test('strokeAt / strokeOffset / wristSpeed / bodyHeight の基本', () => {
  const frames = swingClip();
  const [auto] = findStrokes(frames, 'right');
  const manual = strokeAt(frames, 'right', auto.impact);
  assert.equal(manual.manual, true);
  assert.equal(manual.trophy, auto.trophy);
  assert.ok(strokeOffset(frames, 'right', auto.trophy, auto.impact) < 0, 'テイクバックでは手が体より後ろ');
  assert.ok(strokeOffset(frames, 'right', auto.impact) > 0, 'インパクトでは手が体より前');
  assert.equal(strokeOffset(frames, 'right', null), null);

  const speed = wristSpeed(frames, 'right');
  assert.equal(speed.length, frames.length);
  assert.ok(Math.max(...speed.filter((v) => v != null)) > 2);
  near(bodyHeight(frames), 0.72, 0.03);
  // 足元が映っていなくても、胴の長さから体の高さを見積もって探せる
  const noLegs = swingClip({ legs: false });
  near(bodyHeight(noLegs), 0.725, 0.01);
  assert.equal(findStrokes(noLegs, 'right').length, 1);
});

test('2 本のフォアハンドを比べると、打点の前後の違いが一言で出る', () => {
  const a = evaluate(swingClip({ front: 0.5 }), 'forehand').results;
  const b = evaluate(swingClip({ front: 0.0 }), 'forehand').results;
  const row = compareServes(a, b, 'side').find((r) => r.id === 'impact-front');
  assert.equal(row.notable, true);
  assert.equal(row.text, 'B のほうが体の近く（後ろ寄り）で打っています。');
  void LM;
});
