// 実行: node --test tennis-form/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LM, angleAt, computeMetrics, buildSeries, findServes, serveAt,
  valueAt, poseAt, nearestIndex, frameStep, toPoints, missingTimes,
} from '../docs/js/pose-math.js';

import { near, figure, clip } from './helpers.mjs';

test('angleAt: 直角とまっすぐ', () => {
  near(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90, 1e-9);
  near(angleAt({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }), 180, 1e-9);
  assert.equal(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('toPoints: 横長動画でも角度がゆがまない', () => {
  // 16:9 の画面上で実際には直角になっている 3 点
  const aspect = 16 / 9;
  const pts = toPoints([{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.5 + 0.3 / aspect, y: 0.5 }], aspect);
  near(angleAt(pts[0], pts[1], pts[2]), 90, 1e-6);
});

test('computeMetrics: 腕を真上に伸ばした直立姿勢', () => {
  const m = computeMetrics(figure({ raise: 1, bend: 180 }), 'right');
  near(m.elbow, 180, 0.01, 'elbow');
  near(m.shoulder, 180, 3, 'shoulder');
  near(m.kneeL, 180, 0.01, 'kneeL');
  near(m.kneeR, 180, 0.01, 'kneeR');
  near(m.lean, 0, 0.01, 'lean');
  assert.ok(m.reach > 1.2, `reach ${m.reach}`);
});

test('computeMetrics: 膝を 120° に曲げる', () => {
  const m = computeMetrics(figure({ bend: 120 }), 'right');
  near(m.kneeL, 120, 0.01);
  near(m.kneeR, 120, 0.01);
});

test('computeMetrics: 見えていない点を使う項目は null', () => {
  const pts = figure({ raise: 1 });
  pts[LM.R_WRIST].v = 0.1;
  const m = computeMetrics(pts, 'right');
  assert.equal(m.elbow, null);
  assert.equal(m.reach, null);
  assert.notEqual(m.kneeL, null);
  assert.deepEqual(computeMetrics(null, 'right').elbow, null);
});

test('findServes: 2 本のサーブを見つけ、インパクトとトロフィーの時刻が合う', () => {
  const frames = clip([2.5, 5.0]);
  const serves = findServes(frames, 'right');
  assert.equal(serves.length, 2);
  near(frames[serves[0].impact].t, 2.5, 0.05, 'impact 1');
  near(frames[serves[1].impact].t, 5.0, 0.05, 'impact 2');
  near(frames[serves[0].trophy].t, 2.15, 0.07, 'trophy 1');
  assert.ok(serves[0].trophy < serves[0].impact);
});

test('findServes: 腕を上げない動画と、逆の手を指定した場合は 0 本', () => {
  assert.equal(findServes(clip([]), 'right').length, 0);
  assert.equal(findServes(clip([2.5]), 'left').length, 0);
});

test('findServes: 検出できないフレームが混ざっても落ちない', () => {
  const frames = clip([2.5]);
  for (let i = 0; i < frames.length; i += 7) frames[i].pts = null;
  const serves = findServes(frames, 'right');
  assert.equal(serves.length, 1);
  near(frames[serves[0].impact].t, 2.5, 0.08);
});

test('serveAt: 手で決めたインパクトからトロフィーを探す', () => {
  const frames = clip([2.5]);
  const s = serveAt(frames, nearestIndex(frames, 2.5));
  assert.equal(s.manual, true);
  near(frames[s.trophy].t, 2.15, 0.07);
});

test('valueAt / poseAt: フレームの間を補間し、離れすぎた所は null', () => {
  const frames = [{ t: 0, pts: figure({ raise: 0 }) }, { t: 0.1, pts: figure({ raise: 1 }) }, { t: 2, pts: null }];
  const vals = [10, 20, null];
  near(valueAt(frames, vals, 0.05), 15, 1e-9);
  near(valueAt(frames, vals, 0.1), 20, 1e-9);
  assert.equal(valueAt(frames, vals, 1), null);
  assert.equal(valueAt([], [], 1), null);
  const p = poseAt(frames, 0.05);
  near(p[LM.R_WRIST].y, (frames[0].pts[LM.R_WRIST].y + frames[1].pts[LM.R_WRIST].y) / 2, 1e-9);
  assert.equal(poseAt(frames, 1), null);
});

test('buildSeries: 項目ごとにフレーム数ぶんの値がある', () => {
  const frames = clip([2.5], 4);
  const s = buildSeries(frames, 'right');
  assert.equal(s.elbow.length, frames.length);
  assert.equal(s.kneeL.length, frames.length);
  const i = nearestIndex(frames, 2.15);
  near(s.kneeL[i], 120, 3);
});

test('missingTimes: 抜けた区間だけを刻み幅で埋める', () => {
  const step = 1 / 30;
  const full = Array.from({ length: 90 }, (_, i) => i * step);
  assert.deepEqual(missingTimes(full, 3, step), []);

  // 1.0〜2.0 秒が丸ごと抜けた場合
  const holed = full.filter((t) => t < 1 || t > 2);
  const fill = missingTimes(holed, 3, step);
  assert.ok(fill.length >= 28 && fill.length <= 31, `count ${fill.length}`);
  assert.ok(fill.every((t) => t > 1 - step && t < 2 + step));
  const merged = [...holed, ...fill].sort((a, b) => a - b);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i] - merged[i - 1] < step * 2.6, `gap at ${merged[i]}`);

  // 1 コマも読めなかった場合は全体を埋める（0 秒から、末尾の手前まで）
  const all = missingTimes([], 2, step);
  near(all[0], 0, 1e-9);
  assert.ok(all[all.length - 1] < 2);
  assert.ok(all.length >= 58 && all.length <= 60, `count ${all.length}`);

  // 先頭と末尾だけ抜けた場合
  const middle = full.filter((t) => t >= 1 && t <= 2);
  const ends = missingTimes(middle, 3, step);
  assert.ok(ends.some((t) => t < 0.01) && ends.some((t) => t > 2.9));
  assert.deepEqual(missingTimes([], null, step), []);
});

test('frameStep: 30fps なら約 1/30 秒', () => {
  near(frameStep(clip([], 2)), 1 / 30, 1e-6);
  near(frameStep([]), 1 / 30, 1e-9);
});
