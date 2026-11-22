// サーブの「見直しポイント」を、角度の目安から定型文で出す。
// 画面や動画には触れない純粋な計算だけを置く（Node でそのままテストできる）。
//
// 目安の数値は、一般的な指導内容をもとにした仮の値。班の教え方に合わせて GUIDE を書き換える。
// 真横から撮った動画を前提にしている（斜めや正面からだと角度が小さく出る項目がある）。

export const GUIDE = {
  trophyKnee: { good: 140, shallow: 160 },   // 深く曲げた側の膝の角度（小さいほど深い）
  trophyElbow: { good: 80, low: 60 },        // 利き腕の脇の開き（肘が肩の高さで約 90°）
  trophyToss: { good: 130 },                 // トスを上げた腕の上がり
  impactElbow: { good: 160, bent: 140 },     // 利き腕の肘の角度
  impactReach: { good: 1.2, low: 1.1 },      // 手首の高さ（足首から鼻までの高さの何倍か）
  impactKnee: { good: 155 },                 // 伸びている側の膝の角度
};

// インパクトの前後この秒数の中でいちばん大きい値を使う。
// 30fps だと打つ瞬間がコマの間に落ちるので、1 コマぶんのずれを吸収する。
const IMPACT_WINDOW = 0.1;

// 表の「インパクト」列はその 1 コマの値なので、こちらは前後を見ていることを見出しで断っておく
const MOMENT_LABEL = { trophy: 'トロフィーポーズ', impact: `インパクト（前後 ${IMPACT_WINDOW} 秒でいちばん大きい値）` };

const smaller = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const larger = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

function maxAround(frames, values, index, window) {
  if (index == null) return null;
  const center = frames[index].t;
  let best = null;
  for (let i = index; i >= 0 && center - frames[i].t <= window; i--) best = larger(best, values[i]);
  for (let i = index + 1; i < frames.length && frames[i].t - center <= window; i++) best = larger(best, values[i]);
  return best;
}

/**
 * チェック項目。measure が値（測れなければ null）を返し、judge がその値から判定と文を返す。
 * status は 'good'（目安どおり）か 'hint'（見直しポイント）。
 */
export const CHECKS = [
  {
    id: 'trophy-knee',
    moment: 'trophy',
    title: '膝の曲げ',
    unit: '°',
    digits: 0,
    target: `目安 ${GUIDE.trophyKnee.good}° 以下`,
    measure: ({ series, serve }) =>
      serve.trophy == null ? null : smaller(series.kneeL[serve.trophy], series.kneeR[serve.trophy]),
    judge: (v) => {
      if (v <= GUIDE.trophyKnee.good) return { status: 'good', text: '膝を曲げて、打つ前の「ため」を作れています。' };
      if (v <= GUIDE.trophyKnee.shallow) {
        return { status: 'hint', text: '膝の曲げが浅めです。もう少し沈み込むと、脚の力をボールに伝えやすくなります。' };
      }
      return { status: 'hint', text: '膝がほとんど伸びたままです。トスを上げながら膝を曲げ、下から伸び上がる動きを入れてみましょう。' };
    },
  },
  {
    id: 'trophy-elbow',
    moment: 'trophy',
    title: '利き腕の肘の高さ',
    unit: '°',
    digits: 0,
    target: `目安 ${GUIDE.trophyElbow.good}° 以上`,
    measure: ({ series, serve }) => (serve.trophy == null ? null : series.shoulder[serve.trophy]),
    judge: (v) => {
      if (v >= GUIDE.trophyElbow.good) return { status: 'good', text: '肘が肩の高さまで上がっています。' };
      if (v >= GUIDE.trophyElbow.low) {
        return { status: 'hint', text: '肘が肩より少し下がっています。肩の高さまで上げると、ラケットを振り上げやすくなります。' };
      }
      return { status: 'hint', text: '肘が下がっています。脇を開けて、肘を肩の高さまで上げてみましょう。' };
    },
  },
  {
    id: 'trophy-toss',
    moment: 'trophy',
    title: 'トスの腕',
    unit: '°',
    digits: 0,
    target: `目安 ${GUIDE.trophyToss.good}° 以上`,
    measure: ({ series, serve }) => (serve.trophy == null ? null : series.toss[serve.trophy]),
    judge: (v) => {
      if (v >= GUIDE.trophyToss.good) return { status: 'good', text: 'トスを上げた腕が高く残っています。' };
      return { status: 'hint', text: 'トスを上げた腕が早く下がっています。ボールを離したあとも腕を高く残すと、体が早く開くのを防げます。' };
    },
  },
  {
    id: 'impact-elbow',
    moment: 'impact',
    title: '肘の伸び',
    unit: '°',
    digits: 0,
    target: `目安 ${GUIDE.impactElbow.good}° 以上`,
    measure: ({ frames, series, serve }) => maxAround(frames, series.elbow, serve.impact, IMPACT_WINDOW),
    judge: (v) => {
      if (v >= GUIDE.impactElbow.good) return { status: 'good', text: '腕が伸びた高い位置でボールをとらえています。' };
      if (v >= GUIDE.impactElbow.bent) {
        return { status: 'hint', text: '肘が少し曲がったまま打っています。もう少し高い打点で、腕を伸ばしてとらえてみましょう。' };
      }
      return { status: 'hint', text: '肘が大きく曲がっています。トスが低いか、体に近すぎるかもしれません。' };
    },
  },
  {
    id: 'impact-reach',
    moment: 'impact',
    title: '打点の高さ',
    unit: '倍',
    digits: 2,
    target: `目安 ${GUIDE.impactReach.good.toFixed(1)} 倍以上`,
    measure: ({ frames, series, serve }) => maxAround(frames, series.reach, serve.impact, IMPACT_WINDOW),
    judge: (v) => {
      if (v >= GUIDE.impactReach.good) return { status: 'good', text: '体を伸ばした高い打点です。' };
      if (v >= GUIDE.impactReach.low) {
        return { status: 'hint', text: '打点がやや低めです。トスをもう少し高く上げ、伸び上がって打ってみましょう。' };
      }
      return { status: 'hint', text: '打点が低くなっています。頭より十分高い位置で打てるよう、トスの高さを見直してみましょう。' };
    },
  },
  {
    id: 'impact-knee',
    moment: 'impact',
    title: '膝の伸び',
    unit: '°',
    digits: 0,
    target: `目安 ${GUIDE.impactKnee.good}° 以上`,
    // 後ろ足は蹴り上げて曲がることが多いので、伸びている側の膝で見る
    measure: ({ frames, series, serve }) =>
      larger(
        maxAround(frames, series.kneeL, serve.impact, IMPACT_WINDOW),
        maxAround(frames, series.kneeR, serve.impact, IMPACT_WINDOW),
      ),
    judge: (v) => {
      if (v >= GUIDE.impactKnee.good) return { status: 'good', text: '脚を伸ばしきって、下からの力を使えています。' };
      return { status: 'hint', text: '打つ瞬間に膝が曲がったままです。地面を蹴って伸び上がりながら打つと、打点が高くなります。' };
    },
  },
];

/**
 * サーブ 1 本を評価する。
 * @param {{ frames: {t:number}[], series: Record<string,(number|null)[]>, serve: {impact:number, trophy:number|null} }} input
 * @returns {{ id, moment, momentLabel, title, target, value, valueText, status: 'good'|'hint'|'na', text }[]}
 */
export function evaluateServe({ frames, series, serve }) {
  return CHECKS.map((check) => {
    const value = check.measure({ frames, series, serve });
    const base = {
      id: check.id,
      moment: check.moment,
      momentLabel: MOMENT_LABEL[check.moment],
      title: check.title,
      target: check.target,
    };
    if (value == null) {
      const text = check.moment === 'trophy' && serve.trophy == null
        ? 'トロフィーポーズを見つけられなかったため、測れませんでした。'
        : '測れませんでした。体の一部が映っていないか、うまく読み取れていません。';
      return { ...base, value: null, valueText: '—', status: 'na', text };
    }
    return { ...base, value, valueText: `${value.toFixed(check.digits)}${check.unit}`, ...check.judge(value) };
  });
}

/** 測れた項目数と、そのうち目安どおりだった数 */
export function summarize(results) {
  const measured = results.filter((r) => r.status !== 'na');
  return { measured: measured.length, good: measured.filter((r) => r.status === 'good').length, total: results.length };
}
