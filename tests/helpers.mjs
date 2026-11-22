// テスト用の棒人間。右利きの人を真横から見た形で、関節の角度を指定して作れる。
import { LM } from '../docs/js/pose-math.js';

export const near = (actual, expected, tol, msg) => {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg ?? ''} expected ${expected}±${tol}, got ${actual}`);
  }
};

/**
 * @param {object} p
 * @param {number} [p.raise] 右腕（利き腕）の上げ具合。0 = 真下、0.5 = 水平、1 = 真上（脇の開き = raise × 180°）
 * @param {number} [p.elbow] 右肘の角度（度）。180 でまっすぐ
 * @param {number} [p.toss]  左腕（トスの腕）の上げ具合。raise と同じ尺度
 * @param {number} [p.bend]  両膝の角度（度）。180 でまっすぐ
 * @param {boolean} [p.legs] false にすると膝から下を「見えていない」扱いにする
 */
export function figure({ raise = 0, elbow = 180, toss = 0, bend = 180, legs = true } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0 }));
  const put = (i, x, y, v = 1) => { pts[i] = { x, y, v }; };
  put(LM.NOSE, 0.5, 0.22);
  put(LM.L_SHOULDER, 0.48, 0.3); put(LM.R_SHOULDER, 0.52, 0.3);
  put(LM.L_HIP, 0.48, 0.55); put(LM.R_HIP, 0.52, 0.55);

  // 脚：太もも 0.2、すね 0.2。膝を前に出して曲げる
  const half = ((180 - bend) / 2) * (Math.PI / 180);
  const kneeX = 0.2 * Math.sin(half), legY = 0.2 * Math.cos(half);
  for (const [knee, ankle, x] of [[LM.L_KNEE, LM.L_ANKLE, 0.48], [LM.R_KNEE, LM.R_ANKLE, 0.52]]) {
    put(knee, x + kneeX, 0.55 + legY, legs ? 1 : 0);
    put(ankle, x, 0.55 + 2 * legY, legs ? 1 : 0);
  }

  // 腕：上腕 0.15、前腕 0.15。side = +1 は右へ、-1 は左へ開く
  const arm = (shoulder, elbowIdx, wrist, sx, level, elbowDeg, side) => {
    const a = level * Math.PI - Math.PI / 2;           // -90°（真下）→ +90°（真上）
    const ux = side * Math.cos(a), uy = -Math.sin(a);
    const ex = sx + 0.15 * ux, ey = 0.3 + 0.15 * uy;
    const r = side * (180 - elbowDeg) * (Math.PI / 180); // 肘で前腕を折る
    const fx = ux * Math.cos(r) - uy * Math.sin(r), fy = ux * Math.sin(r) + uy * Math.cos(r);
    put(elbowIdx, ex, ey);
    put(wrist, ex + 0.15 * fx, ey + 0.15 * fy);
    void shoulder;
  };
  arm(LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, 0.52, raise, elbow, 1);
  arm(LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, 0.48, toss, 180, -1);
  return pts;
}

/** 30fps で、指定した時刻にサーブ（膝を曲げてから腕を振り上げる）を入れた動画 */
export function clip(serveTimes, seconds = 6, fps = 30) {
  const frames = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    let raise = 0.1, bend = 170;
    for (const s of serveTimes) {
      const d = t - s;
      if (d > -1.2 && d < 0.6) {
        raise = Math.max(raise, Math.exp(-(d * d) / (2 * 0.12 * 0.12)));   // インパクトで頂点
        const k = d + 0.35;                                                 // その 0.35 秒前に膝が最も曲がる
        bend = Math.min(bend, 170 - 50 * Math.exp(-(k * k) / (2 * 0.15 * 0.15)));
      }
    }
    frames.push({ t, pts: figure({ raise, bend }) });
  }
  return frames;
}

/**
 * トロフィーポーズ（1.0 秒）とインパクト（1.4 秒）の姿勢を指定してサーブ 1 本の動画を作る。
 * 途中は姿勢をなめらかにつなぐ。戻り値は { frames, serve }。
 */
export function serveClip({ trophy, impact }, fps = 30) {
  const rest = { raise: 0.1, elbow: 180, toss: 0.1, bend: 175 };
  const keys = [[0, rest], [1.0, { ...rest, ...trophy }], [1.4, { ...rest, ...impact }], [2.0, rest]];
  const names = ['raise', 'elbow', 'toss', 'bend'];
  const frames = [];
  for (let i = 0; i <= 2 * fps; i++) {
    const t = i / fps;
    let k = 0;
    while (k < keys.length - 2 && t > keys[k + 1][0]) k++;
    const [t0, a] = keys[k], [t1, b] = keys[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const pose = Object.fromEntries(names.map((n) => [n, a[n] + (b[n] - a[n]) * u]));
    frames.push({ t, pts: figure({ ...pose, legs: trophy.legs !== false }) });
  }
  return { frames, serve: { impact: Math.round(1.4 * fps), trophy: Math.round(1.0 * fps), manual: false } };
}
