// 骨格の点から角度を計算し、サーブの山場（トロフィーポーズとインパクト）を探す。
// 画面や動画には触れない純粋な計算だけを置く（Node でそのままテストできる）。
//
// 座標は「動画の高さ = 1」の等方単位。x は 0〜(幅÷高さ)、y は 0〜1 で下向きが正。
// 1 フレームは { t: 秒, pts: 点の配列 | null }、点は { x, y, v }（v は見えている確からしさ 0〜1）。

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

// 骨格として線で結ぶ点の組（顔と手指は省く）
export const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

export const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export const METRICS = [
  { id: 'elbow', label: '肘の角度', hint: '利き腕の肩・肘・手首。180°でまっすぐ', unit: '°', digits: 0 },
  { id: 'shoulder', label: '脇の開き', hint: '利き腕の肘・肩・腰。腕が真上で約 180°', unit: '°', digits: 0 },
  { id: 'toss', label: 'トスの腕の上がり', hint: '反対の腕の肘・肩・腰。腕が真上で約 180°', unit: '°', digits: 0 },
  { id: 'kneeL', label: '左膝の角度', hint: '腰・膝・足首。小さいほど深く曲がっている', unit: '°', digits: 0 },
  { id: 'kneeR', label: '右膝の角度', hint: '腰・膝・足首。小さいほど深く曲がっている', unit: '°', digits: 0 },
  { id: 'lean', label: '体の傾き', hint: '腰から肩への線が垂直から傾いている角度', unit: '°', digits: 0 },
  { id: 'reach', label: '手首の高さ', hint: '足首から手首までの高さ ÷ 足首から鼻までの高さ', unit: '倍', digits: 2 },
];

const MIN_VIS = 0.5;        // 角度の計算に使う点の最低ライン
const MIN_VIS_FAST = 0.3;   // 速く動く手首は確からしさが下がるので、検出用には緩める
const MAX_GAP = 0.25;       // これより間が空いたフレーム同士は補間しない（秒）
const SERVE_MIN_HEIGHT = 0.75; // 手首が肩より「胴の長さ × この値」以上高ければ打ちにいっているとみなす
const SERVE_GAP = 0.5;      // これより間が空いたら別のサーブ（秒）
const TROPHY_FROM = 1.5;    // トロフィーポーズを探す範囲：インパクトの何秒前から
const TROPHY_TO = 0.08;     // 〜何秒前まで

export function armOf(hand) {
  return hand === 'left'
    ? { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST, hip: LM.L_HIP }
    : { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST, hip: LM.R_HIP };
}

/** 利き手と反対の腕（トスを上げる腕） */
export function otherArmOf(hand) {
  return armOf(hand === 'left' ? 'right' : 'left');
}

/** MediaPipe の正規化座標（0〜1）を等方単位の点に直す */
export function toPoints(landmarks, aspect) {
  return landmarks.map((p) => ({ x: p.x * aspect, y: p.y, v: p.visibility ?? 1 }));
}

const seen = (p, min = MIN_VIS) => !!p && p.v >= min;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点 b を頂点とする角度（度）。0〜180 */
export function angleAt(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!d) return null;
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}

function kneeAngle(pts, hip, knee, ankle) {
  const h = pts[hip], k = pts[knee], a = pts[ankle];
  return seen(h) && seen(k) && seen(a) ? angleAt(h, k, a) : null;
}

/** 1 フレーム分の数値。計算できない項目は null */
export function computeMetrics(pts, hand) {
  const out = Object.fromEntries(METRICS.map((m) => [m.id, null]));
  if (!pts) return out;
  const arm = armOf(hand);
  const S = pts[arm.shoulder], E = pts[arm.elbow], W = pts[arm.wrist], H = pts[arm.hip];

  if (seen(S) && seen(E) && seen(W)) out.elbow = angleAt(S, E, W);
  if (seen(E) && seen(S) && seen(H)) out.shoulder = angleAt(E, S, H);
  const other = otherArmOf(hand);
  const OS = pts[other.shoulder], OE = pts[other.elbow], OH = pts[other.hip];
  if (seen(OE) && seen(OS) && seen(OH)) out.toss = angleAt(OE, OS, OH);
  out.kneeL = kneeAngle(pts, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
  out.kneeR = kneeAngle(pts, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);

  const ls = pts[LM.L_SHOULDER], rs = pts[LM.R_SHOULDER], lh = pts[LM.L_HIP], rh = pts[LM.R_HIP];
  if (seen(ls) && seen(rs) && seen(lh) && seen(rh)) {
    const ms = mid(ls, rs), mh = mid(lh, rh);
    const up = mh.y - ms.y; // 肩が腰より上なら正
    const side = Math.abs(ms.x - mh.x);
    if (up > 0 || side > 0) out.lean = (Math.atan2(side, up) * 180) / Math.PI;
  }

  const nose = pts[LM.NOSE];
  const ankles = [pts[LM.L_ANKLE], pts[LM.R_ANKLE]].filter((p) => seen(p));
  if (seen(W) && seen(nose) && ankles.length) {
    const ankleY = ankles.reduce((s, p) => s + p.y, 0) / ankles.length;
    const head = ankleY - nose.y;
    if (head > 0.05) out.reach = (ankleY - W.y) / head;
  }
  return out;
}

/** 前後 1 フレームとの加重平均（1:2:1）。欠けている値は飛ばす */
export function smooth(values) {
  return values.map((v, i) => {
    if (v == null) return null;
    let sum = v * 2, w = 2;
    for (const j of [i - 1, i + 1]) {
      const u = values[j];
      if (u != null) { sum += u; w += 1; }
    }
    return sum / w;
  });
}

/** 全フレームの数値を項目ごとの配列にまとめる（表・グラフ・ラベルは全部これを使う） */
export function buildSeries(frames, hand) {
  const raw = frames.map((f) => computeMetrics(f.pts, hand));
  const series = {};
  for (const m of METRICS) series[m.id] = smooth(raw.map((r) => r[m.id]));
  return series;
}

/** t 以前で最後のフレーム番号。なければ -1 */
export function indexAtOrBefore(frames, t) {
  let lo = 0, hi = frames.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (frames[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

export function nearestIndex(frames, t) {
  if (!frames.length) return -1;
  const i = indexAtOrBefore(frames, t);
  if (i < 0) return 0;
  if (i + 1 < frames.length && frames[i + 1].t - t < t - frames[i].t) return i + 1;
  return i;
}

/** 時刻 t の値を前後のフレームから補間する */
export function valueAt(frames, values, t) {
  const a = indexAtOrBefore(frames, t);
  const b = a + 1 < frames.length ? a + 1 : -1;
  const va = a >= 0 ? values[a] : null;
  const vb = b >= 0 ? values[b] : null;
  if (va != null && vb != null) {
    const span = frames[b].t - frames[a].t;
    if (span > 0 && span <= MAX_GAP) return va + (vb - va) * ((t - frames[a].t) / span);
  }
  if (va != null && t - frames[a].t <= MAX_GAP / 2) return va;
  if (vb != null && frames[b].t - t <= MAX_GAP / 2) return vb;
  return null;
}

/** 時刻 t の骨格を前後のフレームから補間する（スロー再生で滑らかに見せるため） */
export function poseAt(frames, t) {
  const a = indexAtOrBefore(frames, t);
  const b = a + 1 < frames.length ? a + 1 : -1;
  const pa = a >= 0 ? frames[a].pts : null;
  const pb = b >= 0 ? frames[b].pts : null;
  if (pa && pb) {
    const span = frames[b].t - frames[a].t;
    if (span > 0 && span <= MAX_GAP) {
      const k = (t - frames[a].t) / span;
      return pa.map((p, i) => {
        const q = pb[i];
        return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, v: Math.min(p.v, q.v) };
      });
    }
  }
  if (pa && t - frames[a].t <= MAX_GAP / 2) return pa;
  if (pb && frames[b].t - t <= MAX_GAP / 2) return pb;
  return null;
}

// 利き手の手首が、肩の高さから胴の長さの何倍ぶん上にあるか
function wristHeight(pts, arm) {
  if (!pts) return null;
  const ls = pts[LM.L_SHOULDER], rs = pts[LM.R_SHOULDER], lh = pts[LM.L_HIP], rh = pts[LM.R_HIP];
  const w = pts[arm.wrist];
  if (!seen(ls) || !seen(rs) || !seen(lh) || !seen(rh) || !seen(w, MIN_VIS_FAST)) return null;
  const ms = mid(ls, rs), mh = mid(lh, rh);
  const torso = dist(ms, mh);
  if (torso < 0.02) return null;
  return (ms.y - w.y) / torso;
}

// 見えている膝の角度の平均
function kneeBend(pts) {
  if (!pts) return null;
  const ks = [
    kneeAngle(pts, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE),
    kneeAngle(pts, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE),
  ].filter((v) => v != null);
  return ks.length ? ks.reduce((s, v) => s + v, 0) / ks.length : null;
}

function findTrophy(frames, knees, impact) {
  const tImp = frames[impact].t;
  let best = null;
  for (let i = impact - 1; i >= 0; i--) {
    const back = tImp - frames[i].t;
    if (back < TROPHY_TO) continue;
    if (back > TROPHY_FROM) break;
    if (knees[i] != null && (best == null || knees[i] < knees[best])) best = i;
  }
  return best;
}

/**
 * サーブを探す。利き手の手首が頭上まで上がったひとかたまりを 1 本と数え、
 * いちばん高い瞬間をインパクト、その直前で膝がいちばん曲がった瞬間をトロフィーポーズとする。
 * 戻り値は [{ impact: フレーム番号, trophy: フレーム番号 | null, manual: false }]
 */
export function findServes(frames, hand) {
  const arm = armOf(hand);
  const heights = smooth(frames.map((f) => wristHeight(f.pts, arm)));
  const knees = smooth(frames.map((f) => kneeBend(f.pts)));
  const peaks = [];
  let run = null;
  const close = () => {
    if (run && run.count >= 2) peaks.push(run.best);
    run = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const h = heights[i];
    if (h == null || h < SERVE_MIN_HEIGHT) continue;
    if (run && frames[i].t - run.lastT > SERVE_GAP) close();
    if (!run) run = { best: i, lastT: frames[i].t, count: 0 };
    if (h > heights[run.best]) run.best = i;
    run.lastT = frames[i].t;
    run.count += 1;
  }
  close();
  return peaks.map((i) => ({ impact: i, trophy: findTrophy(frames, knees, i), manual: false }));
}

/** 指定したフレームをインパクトとするサーブを作る（手で位置を決めたとき用） */
export function serveAt(frames, impact) {
  const knees = smooth(frames.map((f) => kneeBend(f.pts)));
  return { impact, trophy: findTrophy(frames, knees, impact), manual: true };
}

/**
 * 読めたコマの時刻（昇順）から、抜けている時刻を step 秒刻みで並べる。
 * 先頭（0 秒〜最初のコマ）と末尾（最後のコマ〜total 秒）の抜けも含む。total が null なら末尾は見ない。
 */
export function missingTimes(times, total, step) {
  const out = [];
  const fill = (from, to) => {
    if (to - from <= step * 2.5) return;
    for (let k = 1; from + k * step < to - step * 0.5; k++) out.push(from + k * step);
  };
  if (!times.length) {
    if (total != null) fill(-step, total);
    return out;
  }
  fill(-step, times[0]);
  for (let i = 1; i < times.length; i++) fill(times[i - 1], times[i]);
  if (total != null) fill(times[times.length - 1], total);
  return out;
}

/** コマ送り 1 回ぶんの秒数（解析したフレーム間隔の中央値） */
export function frameStep(frames) {
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
  if (!gaps.length) return 1 / 30;
  gaps.sort((a, b) => a - b);
  const m = gaps[gaps.length >> 1];
  return Math.min(1 / 10, Math.max(1 / 120, m));
}
