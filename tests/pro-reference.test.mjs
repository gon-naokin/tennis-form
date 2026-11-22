// プロの公開データを集計する道具（tools/）のテスト。実データは使わず、棒人間から作った模擬データで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, LM } from '../docs/js/pose-math.js';
import { evaluateServe, CHECKS } from '../docs/js/coaching.js';
import { parseNpy, encodeNpy } from '../tools/npy.mjs';
import { toFrames, dominantHand, measureServe, aggregate, inspect, quantile } from '../tools/build-pro-reference.mjs';
import { near, serveClip } from './helpers.mjs';

// 公開データと同じ Human3.6M の並び
const APP_TO_SRC = new Map([
  [LM.NOSE, 9], [LM.L_SHOULDER, 11], [LM.R_SHOULDER, 14], [LM.L_ELBOW, 12], [LM.R_ELBOW, 15],
  [LM.L_WRIST, 13], [LM.R_WRIST, 16], [LM.L_HIP, 4], [LM.R_HIP, 1],
  [LM.L_KNEE, 5], [LM.R_KNEE, 2], [LM.L_ANKLE, 6], [LM.R_ANKLE, 3],
]);
const MIRROR = new Map([[1, 4], [4, 1], [2, 5], [5, 2], [3, 6], [6, 3], [11, 14], [14, 11], [12, 15], [15, 12], [13, 16], [16, 13]]);

const GOOD = {
  trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 120 },
  impact: { raise: 1, elbow: 180, toss: 0.3, bend: 172 },
};

// 真横から見た 2D の棒人間を、公開データと同じ座標の 3D 点列にする。
// 軸 0 = コートの横方向、軸 1 = 打つ向き（真横から見た横方向）、軸 2 = 高さ（上が正）。
function to3D(frames, { scale = 1, zDown = false, mirror = false } = {}) {
  const T = frames.length;
  const values = new Array(T * 17 * 3).fill(0);
  frames.forEach((f, t) => {
    for (const [app, src] of APP_TO_SRC) {
      const j = mirror ? (MIRROR.get(src) ?? src) : src;
      const p = f.pts[app];
      const lateral = app % 2 === 1 ? -0.1 : 0.1; // 左右の関節を少し離す
      values[(t * 17 + j) * 3 + 0] = lateral * scale * (mirror ? -1 : 1);
      values[(t * 17 + j) * 3 + 1] = p.x * scale;
      values[(t * 17 + j) * 3 + 2] = (zDown ? p.y : 1 - p.y) * scale;
    }
  });
  return { shape: [T, 17, 3], data: Float64Array.from(values) };
}

function expected(poses) {
  const { frames, serve } = serveClip(poses);
  const series = buildSeries(frames, 'right');
  return Object.fromEntries(evaluateServe({ frames, series, serve }).map((r) => [r.id, r.value]));
}

function assertSameValues(actual, want, label) {
  for (const check of CHECKS) {
    const tol = check.unit === '°' ? 4 : 0.04;
    near(actual[check.id], want[check.id], tol, `${label} ${check.id}`);
  }
}

test('npy: float32・float64 を書いて読める', () => {
  const values = [0, 1.5, -2.25, 3, 4, 5];
  for (const descr of ['<f4', '<f8']) {
    const { shape, data } = parseNpy(encodeNpy([1, 2, 3], values, descr));
    assert.deepEqual(shape, [1, 2, 3]);
    assert.deepEqual([...data], values);
  }
});

test('npy: Node の Buffer（大きな領域の一部を指す）でも正しく読める', () => {
  const values = [1.25, -2.5, 3.75, 100, 200, 300];
  const encoded = encodeNpy([2, 3], values);
  // ファイルを読んだときと同じく、先頭に別のデータがある領域の途中から始まる Buffer を作る
  const pooled = Buffer.concat([Buffer.from([9, 9, 9, 9, 9]), Buffer.from(encoded)]).subarray(5);
  assert.notEqual(pooled.byteOffset, 0);
  assert.deepEqual([...parseNpy(pooled).data], values);
});

test('npy: 数値以外の配列や壊れたファイルは読まない', () => {
  const bytes = encodeNpy([2], [1, 2]);
  const header = new TextDecoder('latin1').decode(bytes);
  const asObject = Uint8Array.from(header.replace("'<f4'", "'|O8'"), (c) => c.charCodeAt(0));
  assert.throws(() => parseNpy(asObject), /未対応のデータ型/);
  assert.throws(() => parseNpy(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), /npy ファイルではありません/);
  assert.throws(() => parseNpy(bytes.subarray(0, bytes.length - 2)), /途中で切れています/);
});

test('3D の点列から測った値が、真横の 2D から測った値と一致する', () => {
  const { frames } = serveClip(GOOD);
  const result = measureServe(to3D(frames), { fps: 30 });
  assert.equal(result.hand, 'right');
  assertSameValues(result.values, expected(GOOD), 'そのまま');
});

test('単位（縮尺）や縦軸の向きが違っても同じ値になる', () => {
  const { frames } = serveClip(GOOD);
  const want = expected(GOOD);
  assertSameValues(measureServe(to3D(frames, { scale: 1700 }), { fps: 30 }).values, want, 'ミリ単位');
  assertSameValues(measureServe(to3D(frames, { zDown: true }), { fps: 30 }).values, want, '下が正');
  assertSameValues(measureServe(to3D(frames, { scale: 0.01, zDown: true }), { fps: 30 }).values, want, '小さい単位で下が正');
});

test('左利きの選手は左腕を利き腕として測る', () => {
  const { frames } = serveClip(GOOD);
  const array = to3D(frames, { mirror: true });
  assert.equal(dominantHand(toFrames(array, { fps: 30 })), 'left');
  const result = measureServe(array, { fps: 30 });
  assert.equal(result.hand, 'left');
  assertSameValues(result.values, expected(GOOD), '左利き');
});

test('軸ごとの縮尺の補正（scale）を掛けると、ゆがんだデータを戻せる', () => {
  const { frames } = serveClip(GOOD);
  const array = to3D(frames);
  for (let i = 1; i < array.data.length; i += 3) array.data[i] *= 0.5; // 打つ向きだけ半分に縮んだデータ
  const view = { horizontal: 1, vertical: 2, scale: [1, 2, 1] };
  assertSameValues(measureServe(array, { fps: 30, view }).values, expected(GOOD), '補正あり');
});

test('トスの腕のほうが高く上がっても、あとから頂点に達する腕を利き腕とする', () => {
  const poses = {
    trophy: { raise: 0.5, elbow: 90, toss: 1, bend: 120 },      // トスの腕は真上まで
    impact: { raise: 0.95, elbow: 160, toss: 0.3, bend: 172 },  // 打つ腕は少し曲がって低い。トスの腕は先に下がる
  };
  const { frames } = serveClip(poses);
  const projected = toFrames(to3D(frames), { fps: 30 });
  const top = (index) => Math.min(...projected.map((f) => f.pts[index].y));
  assert.ok(top(LM.L_WRIST) < top(LM.R_WRIST), 'トスの腕のほうが高い状況を作れている');
  assert.equal(dominantHand(projected), 'right');
});

test('腕を上げない点列はサーブとして読まない', () => {
  const { frames } = serveClip({ trophy: { raise: 0.2 }, impact: { raise: 0.3 } });
  assert.equal(measureServe(to3D(frames), { fps: 30 }), null);
});

test('inspect: 骨の長さのばらつきで、縮尺のゆがみに気づける', () => {
  const { frames } = serveClip(GOOD);
  const array = to3D(frames);
  const straight = inspect(array);
  assert.equal(straight.frames, frames.length);
  assert.ok(straight.boneCV < 0.01, `boneCV ${straight.boneCV}`);
  assert.ok(straight.ankleMinusNose[2] < 0, '高さの軸は上が正');
  const squashed = inspect(array, [1, 0.3, 1]);
  assert.ok(squashed.boneCV > straight.boneCV * 5, `squashed ${squashed.boneCV}`);
});

test('quantile: 中央値と四分位', () => {
  near(quantile([1, 2, 3, 4, 5], 0.5), 3, 1e-9);
  near(quantile([1, 2, 3, 4], 0.5), 2.5, 1e-9);
  near(quantile([10, 20, 30, 40, 50], 0.25), 20, 1e-9);
  assert.equal(quantile([], 0.5), null);
});

test('aggregate: 1 選手 1 票で分布を出し、本数の少ない選手は除く', () => {
  const measured = [];
  const add = (group, player, knee, count) => {
    for (let i = 0; i < count; i++) {
      measured.push({ group, player, values: { 'trophy-knee': knee + (i - (count - 1) / 2), 'impact-elbow': 170, 'impact-reach': null } });
    }
  };
  add('men', 'a', 100, 5);
  add('men', 'b', 110, 7);
  add('men', 'c', 120, 5);
  add('men', 'd', 130, 60);   // 本数が多くても 1 票
  add('men', 'e', 999, 4);    // 5 本未満なので除く
  add('women', 'x', 115, 5);
  add('women', 'y', 125, 5);  // 2 人だけ → 項目を出さない

  const out = aggregate(measured);
  assert.equal(out.men.players, 4);
  assert.equal(out.men.serves, 77);
  assert.deepEqual(out.men.checks['trophy-knee'], { players: 4, p25: 107.5, p50: 115, p75: 122.5 });
  assert.equal(out.men.checks['impact-elbow'].p50, 170);
  assert.equal(out.men.checks['impact-reach'], undefined, '測れなかった項目は出さない');
  assert.equal(out.women.players, 2);
  assert.deepEqual(out.women.checks, {});
});
