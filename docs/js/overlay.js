// 2 本の動画の骨格を、足元と体の高さをそろえて 1 枚に重ねて描く。
// 受け取る姿勢は pose-math.js の standardPose() でそろえたもの（足首の中点が原点、鼻が y = -1）。

import { BONES, LM } from './pose-math.js';

const MIN_VIS = 0.3;
const visible = (p) => !!p && p.v >= MIN_VIS;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {(object[] | null)[]} poses 重ねる姿勢（null は描かない）
 * @param {{ colors: string[], labels: string[], wrist: number, surface: string, axis: string, ink?: string }} style
 *        wrist は利き手の手首の点番号。打点の手がかりとして大きな丸で描き、2 人ぶんを点線（ink の色）で結ぶ。
 */
export function drawPoseOverlay(canvas, poses, { colors, labels, wrist, surface, axis, ink = axis }) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 体の高さ 1 を何ピクセルにするか。手を伸ばすと 1.4 倍ほどになるので、その分の余白を取る
  const unit = Math.min((h - 28) / 1.5, w / 1.8);
  const cx = w / 2, ground = h - 14;
  const X = (p) => cx + p.x * unit, Y = (p) => ground + p.y * unit;

  ctx.strokeStyle = axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, ground + 0.5);
  ctx.lineTo(w - 12, ground + 0.5);
  ctx.stroke();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  poses.forEach((pose, i) => {
    if (!pose) return;
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = 3;
    for (const [p, q] of BONES) {
      if (!visible(pose[p]) || !visible(pose[q])) continue;
      ctx.beginPath();
      ctx.moveTo(X(pose[p]), Y(pose[p]));
      ctx.lineTo(X(pose[q]), Y(pose[q]));
      ctx.stroke();
    }
    const nose = pose[LM.NOSE];
    if (visible(nose)) { // 頭
      ctx.beginPath();
      ctx.arc(X(nose), Y(nose), unit * 0.06, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  // 2 人の手首を線で結び、打点のずれを目で追いやすくする
  const wrists = poses.map((pose) => pose?.[wrist]).filter(visible);
  if (wrists.length === 2) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(wrists[0]), Y(wrists[0]));
    ctx.lineTo(X(wrists[1]), Y(wrists[1]));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 手首の丸は骨格の線に隠れないよう、最後にまとめて描く
  poses.forEach((pose, i) => {
    const p = pose?.[wrist];
    if (!visible(p)) return;
    ctx.beginPath();
    ctx.arc(X(p), Y(p), 9, 0, Math.PI * 2);
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = surface;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labels[i], X(p), Y(p) + 0.5);
  });
}
