// サーブの「見直しポイント」を、角度の目安から定型文で出す。
// 画面や動画には触れない純粋な計算だけを置く（Node でそのままテストできる）。
//
// 目安の数値は、プロの公開データ（docs/data/pro-reference.json）の分布に、ゆとりを足して決めている。
// 班の教え方に合わせて GUIDE を書き換えればよい。
//
// 膝の曲げは、撮った向きで見え方が大きく変わる。サーブの構えは体が横を向くので、膝は横（サイドフェンス側）へ
// 曲がる。後ろから撮ると曲がりがそのまま見え、横（ベースラインの延長）から撮るとカメラの方へ曲がるので浅く見える。
// プロの中央値は、後ろから約 100°、横から約 145°。
//
// 以前あった「トロフィーポーズでの利き腕の肘の高さ」は外した。膝が最も曲がった瞬間のプロの値が目安（80° 以上）に
// まったく届かず（中央値 20〜65°）、この瞬間に肘が肩の高さにあるという前提が成り立たなかったため。

import { contactOffset, strokeOffset } from './pose-math.js';

export const VIEWS = { side: '横から', back: '後ろから' };

// サーブの種類。動画ごとに利用者が選ぶ（映像からは判別しない）。
export const SERVE_TYPES = { unset: '未設定', flat: 'フラット', slice: 'スライス', spin: 'スピン（ドライブ）' };

// 種類ごとの、打点の位置の一般的な傾向（判定には使わず、数値を読む手がかりとして添える）
const CONTACT_HINT = {
  flat: { side: 'フラットは、頭より前で打つのが一般的です。', back: 'フラットは、頭より少し利き腕側で打つのが一般的です。' },
  slice: { side: 'スライスは、フラットと同じくらい前で打つのが一般的です。', back: 'スライスは、フラットよりさらに利き腕側で打つのが一般的です。' },
  spin: { side: 'スピンは、フラットより後ろ（頭の真上寄り）で打つのが一般的です。', back: 'スピンは、頭の真上から反対側寄りで打つのが一般的です。' },
};

export const GUIDE = {
  trophyKnee: {                              // 深く曲げた側の膝の角度（小さいほど深い）
    side: { good: 155, shallow: 165 },       //   プロ：145°（半数が 139〜151°）
    back: { good: 120, shallow: 140 },       //   プロ：100°（半数が 92〜107°）
  },
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
 * チェック項目。measure が値（測れなければ null）を返し、judge がその値と撮った向きから判定と文を返す。
 * status は 'good'（目安どおり）、'hint'（見直しポイント）、'info'（良し悪しを決めない参考値）のどれか。
 * target は文字列か、撮った向きを受け取る関数。
 */
export const CHECKS = [
  {
    id: 'trophy-knee',
    moment: 'trophy',
    title: '膝の曲げ',
    unit: '°',
    digits: 0,
    target: (view) => `目安 ${GUIDE.trophyKnee[view].good}° 以下${view === 'side' ? '（横からは浅く見えます）' : ''}`,
    measure: ({ series, serve }) =>
      serve.trophy == null ? null : smaller(series.kneeL[serve.trophy], series.kneeR[serve.trophy]),
    judge: (v, view) => {
      if (v <= GUIDE.trophyKnee[view].good) return { status: 'good', text: '膝を曲げて、打つ前の「ため」を作れています。' };
      if (v <= GUIDE.trophyKnee[view].shallow) {
        return { status: 'hint', text: '膝の曲げが浅めです。もう少し沈み込むと、脚の力をボールに伝えやすくなります。' };
      }
      return { status: 'hint', text: '膝がほとんど伸びたままです。トスを上げながら膝を曲げ、下から伸び上がる動きを入れてみましょう。' };
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
  {
    // 良し悪しは決めず、位置だけを示す。同じ人のフラットとスピンを比べるときの手がかりにする。
    id: 'impact-contact',
    moment: 'impact',
    title: '打点の位置',
    unit: '%',
    digits: 0,
    target: (view) => (view === 'back' ? '頭から利き腕側へのずれ（体の高さ比）' : '頭から前へのずれ（体の高さ比）'),
    measure: ({ frames, serve, hand, view }) => {
      const offset = contactOffset(frames[serve.impact].pts, hand, view);
      return offset == null ? null : offset * 100;
    },
    judge: (v, view, type) => {
      const amount = Math.abs(v).toFixed(0);
      const where = view === 'back'
        ? (v >= 0 ? `頭より ${amount}% 利き腕側` : `頭より ${amount}% 反対側`)
        : (v >= 0 ? `頭より ${amount}% 前（ネット側）` : `頭より ${amount}% 後ろ`);
      const hint = CONTACT_HINT[type]?.[view];
      return { status: 'info', text: `${where}で打っています。${hint ?? ''}` };
    },
  },
];

// ---------------------------------------------------------------- ショットの種類ごとのチェック

export const SHOTS = { serve: 'サーブ', smash: 'スマッシュ', forehand: 'フォアハンド', backhand: 'バックハンド', volley: 'ボレー' };

// 頭上で打つショット。サーブと同じ探し方（手首がいちばん高い瞬間）と場面の名前を使う
export const OVERHEAD = new Set(['serve', 'smash']);

/** 2 つの場面の呼び名。頭上のショットは「トロフィーポーズ」、それ以外は「テイクバック」 */
export function momentNames(shot) {
  return { trophy: OVERHEAD.has(shot) ? 'トロフィーポーズ' : 'テイクバック', impact: 'インパクト' };
}

// サーブ以外の目安。プロのデータがないので、一般的な指導内容をもとにした仮の値。
export const STROKE_GUIDE = {
  prepKnee: { good: 150, shallow: 165 }, // テイクバックでの膝の角度
  front: { good: 10, near: 0 },          // 打点が腰より前にある量（体の高さ比 %）
  volleyFront: { good: 5, near: 0 },
  volleyPrep: { good: -10 },             // ボレーのテイクバックで、手が腰より後ろへ行ってよい量
  volleyKnee: { good: 160 },
};

const SIDE_ONLY = (view) => (view === 'back' ? '前後の位置は、真横から撮った動画で測れます。' : null);

function frontCheck(guide) {
  return {
    id: 'impact-front',
    moment: 'impact',
    title: '打点の前後',
    unit: '%',
    digits: 0,
    target: `目安 腰より ${guide.good}% 以上 前（仮）`,
    naText: SIDE_ONLY,
    measure: ({ frames, serve, hand, view }) => {
      if (view !== 'side') return null;
      const offset = strokeOffset(frames, hand, serve.impact);
      return offset == null ? null : offset * 100;
    },
    judge: (v) => {
      if (v >= guide.good) return { status: 'good', text: '体より前でボールをとらえています。' };
      if (v >= guide.near) return { status: 'hint', text: '打点が体に近めです。もう少し前でとらえると、力が伝わりやすくなります。' };
      return { status: 'hint', text: '打点が体より後ろです。振り遅れているかもしれません。早めに準備してみましょう。' };
    },
  };
}

const GROUNDSTROKE_CHECKS = [
  {
    id: 'prep-knee',
    moment: 'trophy',
    title: '膝の曲げ',
    unit: '°',
    digits: 0,
    target: `目安 ${STROKE_GUIDE.prepKnee.good}° 以下（仮）`,
    measure: ({ series, serve }) =>
      serve.trophy == null ? null : smaller(series.kneeL[serve.trophy], series.kneeR[serve.trophy]),
    judge: (v) => {
      if (v <= STROKE_GUIDE.prepKnee.good) return { status: 'good', text: '膝を曲げて、打つ前の「ため」を作れています。' };
      if (v <= STROKE_GUIDE.prepKnee.shallow) return { status: 'hint', text: '膝の曲げが浅めです。もう少し腰を落とすと、下半身の力を使いやすくなります。' };
      return { status: 'hint', text: '膝がほとんど伸びたままです。腰を落として構えてみましょう。' };
    },
  },
  frontCheck(STROKE_GUIDE.front),
  {
    // 肘を曲げて打つ型も伸ばして打つ型もあるので、良し悪しは決めない
    id: 'impact-elbow-info',
    moment: 'impact',
    title: '肘の角度',
    unit: '°',
    digits: 0,
    target: '曲げて打つ型も、伸ばして打つ型もあります',
    measure: ({ frames, series, serve }) => series.elbow[serve.impact] ?? maxAround(frames, series.elbow, serve.impact, IMPACT_WINDOW),
    judge: (v) => ({ status: 'info', text: v >= 150 ? '肘を伸ばしてとらえています。' : '肘を曲げてとらえています。' }),
  },
];

const VOLLEY_CHECKS = [
  {
    id: 'prep-compact',
    moment: 'trophy',
    title: 'テイクバックの大きさ',
    unit: '%',
    digits: 0,
    target: `目安 腰より後ろへ ${-STROKE_GUIDE.volleyPrep.good}% まで（仮）`,
    naText: SIDE_ONLY,
    measure: ({ frames, serve, hand, view }) => {
      if (view !== 'side' || serve.trophy == null) return null;
      const offset = strokeOffset(frames, hand, serve.trophy, serve.impact);
      return offset == null ? null : offset * 100;
    },
    judge: (v) => (v >= STROKE_GUIDE.volleyPrep.good
      ? { status: 'good', text: 'ラケットを引きすぎず、コンパクトに構えられています。' }
      : { status: 'hint', text: '手を体の後ろまで引いています。ボレーは体の前で小さく構えてみましょう。' }),
  },
  frontCheck(STROKE_GUIDE.volleyFront),
  {
    id: 'impact-knee-bend',
    moment: 'impact',
    title: '膝の曲げ',
    unit: '°',
    digits: 0,
    target: `目安 ${STROKE_GUIDE.volleyKnee.good}° 以下（仮）`,
    measure: ({ series, serve }) => smaller(series.kneeL[serve.impact], series.kneeR[serve.impact]),
    judge: (v) => (v <= STROKE_GUIDE.volleyKnee.good
      ? { status: 'good', text: '膝を曲げて、低い姿勢で打てています。' }
      : { status: 'hint', text: '膝が伸びています。膝を曲げてボールの高さに合わせると、面が安定します。' }),
  },
];

const byId = (id) => CHECKS.find((c) => c.id === id);

/** そのショットで見るチェック項目 */
export function checksFor(shot) {
  if (shot === 'smash') return ['trophy-toss', 'impact-elbow', 'impact-reach', 'impact-contact'].map(byId);
  if (shot === 'forehand' || shot === 'backhand') return GROUNDSTROKE_CHECKS;
  if (shot === 'volley') return VOLLEY_CHECKS;
  return CHECKS;
}

/**
 * ショット 1 本を評価する（名前は最初にサーブ専用だったころのまま）。
 * @param {{ frames: {t:number, pts:object[]|null}[], series: Record<string,(number|null)[]>, serve: {impact:number, trophy:number|null},
 *           view?: 'side'|'back', hand?: 'right'|'left', type?: keyof SERVE_TYPES, shot?: keyof SHOTS }} input
 * @returns {{ id, moment, momentLabel, title, target, unit, digits, value, valueText, status: 'good'|'hint'|'info'|'na', text }[]}
 */
export function evaluateServe({ frames, series, serve, view = 'side', hand = 'right', type = 'unset', shot = 'serve' }) {
  const names = momentNames(shot);
  return checksFor(shot).map((check) => {
    const value = check.measure({ frames, series, serve, hand, view });
    const base = {
      id: check.id,
      moment: check.moment,
      // サーブ・スマッシュのインパクトは前後の最大値で見ているので、その断り書き付きの名前にする
      momentLabel: OVERHEAD.has(shot) ? MOMENT_LABEL[check.moment] : names[check.moment],
      title: check.title,
      target: typeof check.target === 'function' ? check.target(view) : check.target,
      unit: check.unit,
      digits: check.digits,
    };
    if (value == null) {
      const text = check.naText?.(view)
        ?? (check.moment === 'trophy' && serve.trophy == null
          ? `${names.trophy}を見つけられなかったため、測れませんでした。`
          : '測れませんでした。体の一部が映っていないか、うまく読み取れていません。');
      return { ...base, value: null, valueText: '—', status: 'na', text };
    }
    return { ...base, value, valueText: `${value.toFixed(check.digits)}${check.unit}`, ...check.judge(value, view, type) };
  });
}

// これ以上違えば「はっきり違う」とみなす幅（単位ごと）。読み取りの揺れより十分大きい差だけを目立たせる。
export const DIFF_SCALE = { '°': 10, '倍': 0.05, '%': 5 };

// はっきり違うときに添える一言（diff = B − A）
const DIFF_TEXT = {
  'trophy-knee': (d) => (d < 0 ? 'B のほうが膝を深く曲げています。' : 'A のほうが膝を深く曲げています。'),
  'trophy-toss': (d) => (d > 0 ? 'B のほうがトスの腕が高く残っています。' : 'A のほうがトスの腕が高く残っています。'),
  'impact-elbow': (d) => (d > 0 ? 'B のほうが肘が伸びています。' : 'A のほうが肘が伸びています。'),
  'impact-reach': (d) => (d > 0 ? 'B のほうが打点が高くなっています。' : 'A のほうが打点が高くなっています。'),
  'impact-knee': (d) => (d > 0 ? 'B のほうが膝が伸びています。' : 'A のほうが膝が伸びています。'),
  'impact-contact': (d, view) => (view === 'back'
    ? (d > 0 ? 'B のほうが利き腕側で打っています。' : 'B のほうが頭の真上寄り（反対側）で打っています。')
    : (d > 0 ? 'B のほうが前（ネット側）で打っています。' : 'B のほうが後ろ（頭の真上寄り）で打っています。')),
  'prep-knee': (d) => (d < 0 ? 'B のほうが膝を深く曲げています。' : 'A のほうが膝を深く曲げています。'),
  'impact-front': (d) => (d > 0 ? 'B のほうが前で打っています。' : 'B のほうが体の近く（後ろ寄り）で打っています。'),
  'impact-elbow-info': (d) => (d > 0 ? 'B のほうが肘を伸ばして打っています。' : 'A のほうが肘を伸ばして打っています。'),
  'prep-compact': (d) => (d > 0 ? 'B のほうがコンパクトに構えています。' : 'A のほうがコンパクトに構えています。'),
  'impact-knee-bend': (d) => (d < 0 ? 'B のほうが膝を曲げています。' : 'A のほうが膝を曲げています。'),
};

/**
 * 2 本のサーブの評価結果（evaluateServe の戻り値）を項目ごとに比べ、違いの大きい順に並べる。
 * 両方で測れた項目だけを返す。差は表示している（丸めた）数字どうしで出す。
 * @returns {{ id, title, momentLabel, aText, bText, diff, diffText, score, notable, text }[]}
 */
export function compareServes(resultsA, resultsB, view = 'side') {
  const byId = new Map(resultsB.map((r) => [r.id, r]));
  const rows = [];
  for (const a of resultsA) {
    const b = byId.get(a.id);
    if (!b || a.value == null || b.value == null) continue;
    const diff = Number(b.value.toFixed(b.digits)) - Number(a.value.toFixed(a.digits));
    const score = Math.abs(diff) / DIFF_SCALE[a.unit];
    const notable = score >= 1;
    const amount = `${Math.abs(diff).toFixed(a.digits)}${a.unit}`;
    rows.push({
      id: a.id,
      title: a.title,
      momentLabel: a.momentLabel,
      aText: a.valueText,
      bText: b.valueText,
      diff,
      diffText: diff > 0 ? `+${amount}` : diff < 0 ? `−${amount}` : `±${amount}`,
      score,
      notable,
      text: notable ? DIFF_TEXT[a.id](diff, view) : 'ほぼ同じです。',
    });
  }
  return rows.sort((p, q) => q.score - p.score);
}

/** 判定のある項目（良い・見直し）のうち測れた数と、そのうち目安どおりだった数。「参考」の項目は数えない */
export function summarize(results) {
  const measured = results.filter((r) => r.status === 'good' || r.status === 'hint');
  return { measured: measured.length, good: measured.filter((r) => r.status === 'good').length, total: results.length };
}
