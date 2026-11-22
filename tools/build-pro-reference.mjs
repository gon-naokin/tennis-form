// プロのサーブの公開骨格データから、アプリに載せる「参考値」を集計する。
//
// データ: Wang ほか "Large-Scale 3D Pose Estimation of Professional Tennis Serves from Broadcast Video" (2026)
//         https://github.com/jasnwag/tennis_serve_dataset （CC BY 4.0）
//
// アプリと同じ計算（docs/js/pose-math.js・coaching.js）をそのまま使うので、
// 「真横から撮った動画を解析した値」と同じ定義の数値になる。
//
// 使い方:
//   1) 付属情報を JSON にする   python -I tools/parquet_to_json.py <metadata.parquet> <metadata.json>
//   2) 中身を確かめる           node tools/build-pro-reference.mjs --keypoints <フォルダ> --inspect
//   3) 集計して書き出す         node tools/build-pro-reference.mjs --keypoints <フォルダ> --meta <metadata.json> --out docs/data/pro-reference.json
//
// 元データ（.npy・parquet）はリポジトリに入れない。入れるのは集計結果の JSON だけ。

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSeries, findServes, LM } from '../docs/js/pose-math.js';
import { evaluateServe, CHECKS } from '../docs/js/coaching.js';
import { parseNpy } from './npy.mjs';

// データの 17 点は Human3.6M の並び（公開ページの説明は COCO だが、実物は違った）:
//   0 腰の中心, 1-3 右の腰・膝・足首, 4-6 左の腰・膝・足首, 7 背, 8 胸, 9 鼻, 10 頭頂,
//   11-13 左の肩・肘・手首, 14-16 右の肩・肘・手首
// これをアプリ（MediaPipe）の点番号に対応させる。
const SRC = {
  NOSE: 9,
  R_HIP: 1, R_KNEE: 2, R_ANKLE: 3,
  L_HIP: 4, L_KNEE: 5, L_ANKLE: 6,
  L_SHOULDER: 11, L_ELBOW: 12, L_WRIST: 13,
  R_SHOULDER: 14, R_ELBOW: 15, R_WRIST: 16,
};
const SRC_TO_APP = new Map(Object.entries(SRC).map(([name, index]) => [index, LM[name]]));

// 長さが変わらないはずの骨（手足 8 本）。座標の縮尺が軸ごとに揃っているか、推定がどれだけ揺れているかの確認に使う。
const BONES = [[1, 2], [2, 3], [4, 5], [5, 6], [11, 12], [12, 13], [14, 15], [15, 16]];

/**
 * 3D の点列を「真横から見た図」にする設定。
 * 実データの軸は 0 = コートの横方向、1 = コートの縦方向（打つ向き）、2 = 高さ（上が正、地面が 0）。
 * horizontal: 横軸に使う軸（打つ向き = 1 を横にすると、ベースラインの延長から見た「真横」になる）
 * vertical:   縦軸に使う軸
 * scale:      軸ごとの縮尺の補正（実データは揃っていたので 1 のまま）
 */
export const DEFAULT_VIEW = { horizontal: 1, vertical: 2, scale: [1, 1, 1] };

// アプリの「撮った向き」と、横軸に使うデータの軸。
//   side（横から）= ベースラインの延長から見る → 打つ向き（軸 1）が横
//   back（後ろから）= サーバーの後ろから見る → コートの横方向（軸 0）が横。中継カメラの見え方にいちばん近い
export const VIEW_AXES = { side: 1, back: 0 };

const BODY_HEIGHT = 0.6;      // 足首から鼻までを、アプリの単位（動画の高さ = 1）でこの大きさに揃える
const MIN_SERVES_PER_PLAYER = 5;

const median = (values) => quantile(values, 0.5);

export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * (T, 17, 3) の 3D 点列を、アプリの解析結果と同じ形（真横から見た 2D のコマ列）に直す。
 * 縦軸の向き（上が正か下が正か）はデータから判定し、体の大きさも揃える。
 */
export function toFrames({ shape, data }, { fps = 60, view = DEFAULT_VIEW } = {}) {
  const [T, J, D] = shape;
  if (J !== 17 || D !== 3) throw new Error(`想定外の形です: (${shape.join(', ')})`);
  const at = (t, j, axis) => data[(t * J + j) * 3 + axis] * view.scale[axis];

  // 縦軸の向きと体の大きさ：足首の中点から鼻までの縦の差（コマごと）の中央値で決める
  const spans = [];
  for (let t = 0; t < T; t++) {
    const ankle = (at(t, SRC.L_ANKLE, view.vertical) + at(t, SRC.R_ANKLE, view.vertical)) / 2;
    const span = ankle - at(t, SRC.NOSE, view.vertical);
    if (Number.isFinite(span)) spans.push(span);
  }
  const span = median(spans);
  if (!span) throw new Error('体の向きを判定できません');
  const k = BODY_HEIGHT / span; // span が負（上が正のデータ）なら符号ごと反転して「下が正」にする

  const frames = [];
  for (let t = 0; t < T; t++) {
    const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
    let ok = true;
    for (const [src, app] of SRC_TO_APP) {
      const x = at(t, src, view.horizontal) * Math.abs(k);
      const y = at(t, src, view.vertical) * k;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { ok = false; break; }
      pts[app] = { x, y, v: 1 };
    }
    frames.push({ t: t / fps, pts: ok ? pts : null });
  }
  return frames;
}

// 手首がいちばん高くなる時刻。1 コマだけの飛びに引きずられないよう、前後 2 コマずつの平均で見る。
function peakTime(frames, index) {
  const ys = frames.map((f) => (f.pts ? f.pts[index].y : null));
  let best = null, bestY = Infinity;
  for (let i = 0; i < ys.length; i++) {
    let sum = 0, n = 0;
    for (let j = i - 2; j <= i + 2; j++) if (ys[j] != null) { sum += ys[j]; n += 1; }
    if (n && sum / n < bestY) { bestY = sum / n; best = frames[i].t; }
  }
  return best;
}

/**
 * 利き手：手首が最も高くなるのが遅い側。
 * トスの腕が先に上がり、打つ腕はそのあとインパクトで頂点に達する。
 * 高さや速さで決める方法は、実データでは同じ選手でも判定がばらついたので使わない
 * （この方法だと、15 本以上ある 80 人中 78 人で判定が一貫した）。
 */
export function dominantHand(frames) {
  return peakTime(frames, LM.L_WRIST) > peakTime(frames, LM.R_WRIST) ? 'left' : 'right';
}

/**
 * サーブ 1 本ぶんの点列から、フォームのチェック 6 項目の値を出す。
 * サーブとして読み取れなければ null。
 */
export function measureServe(array, options) {
  const frames = toFrames(array, options);
  const hand = dominantHand(frames);
  const series = buildSeries(frames, hand);
  const serves = findServes(frames, hand);
  if (!serves.length) return null;
  // 1 ファイルに 1 本のはずだが、複数見つかったら手首がいちばん高いものを採る
  const serve = serves.reduce((best, s) =>
    (frames[s.impact].pts[hand === 'left' ? LM.L_WRIST : LM.R_WRIST].y
      < frames[best.impact].pts[hand === 'left' ? LM.L_WRIST : LM.R_WRIST].y ? s : best));
  const values = {};
  for (const r of evaluateServe({ frames, series, serve, hand, view: options?.viewId ?? 'side' })) values[r.id] = r.value;
  return { hand, values };
}

/**
 * 選手ごとの中央値を出し、その分布（25%・50%・75%）をグループごとにまとめる。
 * 本数の多い選手に引きずられないよう、1 選手 1 票にする。
 * @param {{ group: string, player: string, values: Record<string, number|null> }[]} measured
 */
export function aggregate(measured, { minServes = MIN_SERVES_PER_PLAYER } = {}) {
  const groups = new Map();
  for (const m of measured) {
    if (!groups.has(m.group)) groups.set(m.group, new Map());
    const players = groups.get(m.group);
    if (!players.has(m.player)) players.set(m.player, []);
    players.get(m.player).push(m.values);
  }
  const out = {};
  for (const [group, players] of groups) {
    const kept = [...players.values()].filter((serves) => serves.length >= minServes);
    const checks = {};
    for (const check of CHECKS) {
      const perPlayer = kept
        .map((serves) => serves.map((v) => v[check.id]).filter((v) => v != null))
        .filter((vals) => vals.length >= minServes)
        .map(median);
      if (perPlayer.length < 3) continue;
      const round = (v) => Number(v.toFixed(check.digits + 1));
      checks[check.id] = {
        players: perPlayer.length,
        p25: round(quantile(perPlayer, 0.25)),
        p50: round(quantile(perPlayer, 0.5)),
        p75: round(quantile(perPlayer, 0.75)),
      };
    }
    out[group] = {
      players: kept.length,
      serves: kept.reduce((n, serves) => n + serves.length, 0),
      checks,
    };
  }
  return out;
}

/**
 * データの形を確かめる。軸ごとの値の範囲、縦軸の向き、骨の長さのばらつきを返す。
 * 骨の長さがコマによって大きく変わるなら、軸ごとの縮尺が揃っていない。
 */
export function inspect({ shape, data }, scale = [1, 1, 1]) {
  const [T, J] = shape;
  const range = [0, 1, 2].map((axis) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = axis; i < data.length; i += 3) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
    return [lo, hi];
  });
  const point = (t, j) => [0, 1, 2].map((axis) => data[(t * J + j) * 3 + axis] * scale[axis]);
  const cvs = BONES.map(([a, b]) => {
    const lengths = [];
    for (let t = 0; t < T; t++) {
      const p = point(t, a), q = point(t, b);
      lengths.push(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length);
    return mean ? sd / mean : NaN;
  });
  const headUp = [0, 1, 2].map((axis) => {
    let sum = 0;
    for (let t = 0; t < T; t++) {
      sum += (point(t, SRC.L_ANKLE)[axis] + point(t, SRC.R_ANKLE)[axis]) / 2 - point(t, SRC.NOSE)[axis];
    }
    return sum / T;
  });
  return { frames: T, range, boneCV: cvs.reduce((s, v) => s + v, 0) / cvs.length, ankleMinusNose: headUp };
}

// ---------------------------------------------------------------- コマンドとして実行したとき

function parseArgs(argv) {
  const args = { inspect: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inspect') args.inspect = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function listNpy(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.npy')).sort();
  return names.map((n) => path.join(dir, n));
}

async function runInspect(files, scale) {
  const sample = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 40)) === 0).slice(0, 40);
  console.log(`ファイル数: ${files.length}（うち ${sample.length} 本を調べる）`);
  const rows = [];
  for (const file of sample) rows.push(inspect(parseNpy(await readFile(file)), scale));
  const avg = (pick) => rows.reduce((s, r) => s + pick(r), 0) / rows.length;
  console.log('コマ数（最小〜最大）:', Math.min(...rows.map((r) => r.frames)), '〜', Math.max(...rows.map((r) => r.frames)));
  for (const axis of [0, 1, 2]) {
    console.log(`軸 ${axis}: 値の範囲 ${avg((r) => r.range[axis][0]).toFixed(3)} 〜 ${avg((r) => r.range[axis][1]).toFixed(3)}、`
      + `足首 − 鼻 = ${avg((r) => r.ankleMinusNose[axis]).toFixed(3)}`);
  }
  console.log(`骨の長さのばらつき（標準偏差 ÷ 平均、小さいほど良い）: ${avg((r) => r.boneCV).toFixed(3)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.keypoints) {
    console.error('使い方: node tools/build-pro-reference.mjs --keypoints <フォルダ> [--inspect] [--meta <json>] [--out <json>] [--scale x,y,z] [--fps 60] [--min-quality 3] [--dump <json>]');
    process.exit(1);
  }
  const scale = args.scale ? args.scale.split(',').map(Number) : [1, 1, 1];
  const files = await listNpy(args.keypoints);
  if (args.inspect) { await runInspect(files, scale); return; }

  const minQuality = Number(args['min-quality'] ?? 3);
  const rows = JSON.parse(await readFile(args.meta, 'utf8'));
  const byStem = new Map(rows.map((r) => [String(r.stem), r]));
  const fps = Number(args.fps ?? 60);

  // 先に全ファイルを読み、同じ点列を 2 つの向きから見る
  const arrays = [];
  let unmatched = 0, lowQuality = 0;
  for (const file of files) {
    const row = byStem.get(path.basename(file, '.npy'));
    if (!row) { unmatched += 1; continue; }
    if (!(row.quality >= minQuality)) { lowQuality += 1; continue; }
    arrays.push({ row, array: parseNpy(await readFile(file)) });
  }
  console.log(`対象のサーブ: ${arrays.length} / ${files.length}（付属情報なし ${unmatched}、品質 ${minQuality} 未満 ${lowQuality}）`);

  const views = {};
  for (const [id, horizontal] of Object.entries(VIEW_AXES)) {
    const view = { ...DEFAULT_VIEW, scale, horizontal };
    const measured = [];
    let unread = 0;
    for (const { row, array } of arrays) {
      const result = measureServe(array, { fps, view, viewId: id });
      if (!result) { unread += 1; continue; }
      measured.push({ group: row.group, player: row.player, hand: result.hand, values: result.values });
    }
    console.log(`[${id}] 読めたサーブ: ${measured.length}（サーブとして読めず ${unread}）`);
    if (args.dump) await writeFile(args.dump.replace(/\.json$/, `-${id}.json`), JSON.stringify(measured));
    views[id] = aggregate(measured);
  }

  const output = {
    source: {
      title: 'Large-Scale 3D Pose Estimation of Professional Tennis Serves from Broadcast Video',
      authors: 'Jason Wang, Stephen Baek, Robert Chen, Patrick Ho, Emmy Kim, Samuel Min, Jaden Shim, Vrishak Vemuri, Derek Wang, Natalie Kupperman',
      url: 'https://github.com/jasnwag/tennis_serve_dataset',
      license: 'CC BY 4.0',
    },
    note: '2024 年全米オープンの中継映像から推定された 3D の骨格を、横から・後ろから見た形に直し、アプリと同じ計算で求めた値。選手ごとの中央値の分布（25%・50%・75%）。追跡の乱れがないと確認されたサーブだけを使用。',
    views,
  };
  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(output, null, 1)}\n`);
    console.log('書き出しました:', args.out);
  } else {
    console.log(JSON.stringify(views, null, 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
