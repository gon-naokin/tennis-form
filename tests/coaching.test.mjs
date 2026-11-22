// 実行: node --test tennis-form/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, computeMetrics, contactOffset, LM } from '../docs/js/pose-math.js';
import { evaluateServe, summarize, CHECKS, GUIDE, SERVE_TYPES } from '../docs/js/coaching.js';
import { near, figure, serveClip } from './helpers.mjs';

function evaluate(poses, edit, view = 'back') {
  const { frames, serve } = serveClip(poses);
  edit?.(frames, serve);
  const series = buildSeries(frames, 'right');
  const results = evaluateServe({ frames, series, serve, view });
  return { results, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

// 良し悪しを判定する項目（「打点の位置」は参考値なので除く）
const judged = (r) => r.id !== 'impact-contact';

const GOOD = {
  trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 105 },
  impact: { raise: 1, elbow: 180, toss: 0.3, bend: 172 },
};

test('棒人間：トスの腕と肘の角度が指定どおりに測れる', () => {
  const m = computeMetrics(figure({ raise: 0.5, elbow: 90, toss: 0.9, bend: 120 }), 'right');
  near(m.shoulder, 90, 0.01, 'shoulder');
  near(m.elbow, 90, 0.01, 'elbow');
  near(m.toss, 162, 0.01, 'toss');
  near(m.kneeL, 120, 0.01, 'kneeL');
  // 左利きとして測ると、利き腕とトスの腕が入れ替わる
  const left = computeMetrics(figure({ raise: 0.5, toss: 0.9 }), 'left');
  near(left.shoulder, 162, 0.01, 'left shoulder');
  near(left.toss, 90, 0.01, 'left toss');
});

test('目安どおりのサーブは全項目が「良い」', () => {
  const { results } = evaluate(GOOD);
  assert.equal(results.length, CHECKS.length);
  for (const r of results.filter(judged)) assert.equal(r.status, 'good', `${r.id}: ${r.valueText} ${r.text}`);
  assert.deepEqual(summarize(results), { measured: 5, good: 5, total: 6 });
});

test('測った値が項目ごとに合っている', () => {
  const { byId } = evaluate(GOOD);
  near(byId['trophy-knee'].value, 105, 3);
  assert.equal(byId['trophy-elbow'], undefined, '肘の高さの項目は外した');
  near(byId['trophy-toss'].value, 162, 4);
  near(byId['impact-elbow'].value, 180, 3);
  near(byId['impact-knee'].value, 172, 3);
  assert.ok(byId['impact-reach'].value > 1.25, `reach ${byId['impact-reach'].value}`);
  assert.equal(byId['trophy-knee'].valueText, `${byId['trophy-knee'].value.toFixed(0)}°`);
  assert.match(byId['impact-reach'].valueText, /^\d\.\d\d倍$/);
  assert.equal(byId['trophy-knee'].momentLabel, 'トロフィーポーズ');
  assert.match(byId['impact-elbow'].momentLabel, /^インパクト（前後 0\.1 秒/);
});

test('崩れたサーブは全項目が「見直しポイント」になり、程度の強い文が出る', () => {
  const { results, byId } = evaluate({
    trophy: { raise: 0.25, elbow: 150, toss: 0.4, bend: 172 },
    impact: { raise: 0.8, elbow: 125, toss: 0.1, bend: 140 },
  });
  for (const r of results.filter(judged)) assert.equal(r.status, 'hint', `${r.id}: ${r.valueText}`);
  assert.match(byId['trophy-knee'].text, /ほとんど伸びたまま/);
  assert.match(byId['trophy-toss'].text, /早く下がっています/);
  assert.match(byId['impact-elbow'].text, /大きく曲がっています/);
  assert.match(byId['impact-reach'].text, /低/);
  assert.match(byId['impact-knee'].text, /曲がったまま/);
  assert.deepEqual(summarize(results), { measured: 5, good: 0, total: 6 });
});

test('少しだけ外れた場合は、程度の弱い文になる', () => {
  const { byId } = evaluate({
    trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 130 },   // 後ろから見て膝 130°
    impact: { raise: 1, elbow: 150, toss: 0.3, bend: 172 },
  });
  assert.equal(byId['trophy-knee'].status, 'hint');
  assert.match(byId['trophy-knee'].text, /浅め/);
  assert.equal(byId['impact-elbow'].status, 'hint');
  assert.match(byId['impact-elbow'].text, /少し曲がったまま/);
  assert.equal(byId['trophy-toss'].status, 'good');
});

test('境目の値は「良い」側に入る', () => {
  const knee = CHECKS.find((c) => c.id === 'trophy-knee');
  for (const view of ['side', 'back']) {
    assert.equal(knee.judge(GUIDE.trophyKnee[view].good, view).status, 'good');
    assert.equal(knee.judge(GUIDE.trophyKnee[view].good + 0.1, view).status, 'hint');
  }
  const elbow = CHECKS.find((c) => c.id === 'impact-elbow');
  assert.equal(elbow.judge(GUIDE.impactElbow.good).status, 'good');
  assert.equal(elbow.judge(GUIDE.impactElbow.good - 0.1).status, 'hint');
});

test('膝から下が映っていないと、膝と打点の高さは「測れず」', () => {
  const { results, byId } = evaluate({ trophy: { ...GOOD.trophy, legs: false }, impact: GOOD.impact });
  for (const id of ['trophy-knee', 'impact-knee', 'impact-reach']) {
    assert.equal(byId[id].status, 'na', id);
    assert.equal(byId[id].value, null);
    assert.equal(byId[id].valueText, '—');
    assert.match(byId[id].text, /測れませんでした/);
  }
  for (const id of ['trophy-toss', 'impact-elbow']) assert.equal(byId[id].status, 'good', id);
  assert.deepEqual(summarize(results), { measured: 2, good: 2, total: 6 });
});

test('トロフィーポーズが見つからないと、その 3 項目は理由つきで「測れず」', () => {
  const { byId } = evaluate(GOOD, (_frames, serve) => { serve.trophy = null; });
  for (const id of ['trophy-knee', 'trophy-toss']) {
    assert.equal(byId[id].status, 'na', id);
    assert.match(byId[id].text, /トロフィーポーズを見つけられなかった/);
  }
  assert.equal(byId['impact-elbow'].status, 'good');
});

test('インパクトのコマで腕を読み取れなくても、前後のコマの値で判定する', () => {
  const { byId } = evaluate(GOOD, (frames, serve) => { frames[serve.impact].pts = null; });
  assert.equal(byId['impact-elbow'].status, 'good');
  assert.ok(byId['impact-elbow'].value > 165, `elbow ${byId['impact-elbow'].value}`);
});

test('後ろ足を蹴り上げて曲げていても、伸びている側の膝で判定する', () => {
  const { byId } = evaluate(GOOD, (frames, serve) => {
    // インパクト前後で右足だけ曲げる（右膝を右足首の位置へ寄せて角度を小さくする）
    for (let i = serve.impact - 4; i <= serve.impact + 4; i++) {
      const p = frames[i].pts;
      p[28] = { x: p[26].x + 0.15, y: p[26].y, v: 1 };
    }
  });
  assert.equal(byId['impact-knee'].status, 'good');
});

test('膝の曲げは、撮った向きで目安が変わる', () => {
  const poses = { trophy: { raise: 0.5, elbow: 90, toss: 0.9, bend: 145 }, impact: GOOD.impact };
  const side = evaluate(poses, undefined, 'side').byId['trophy-knee'];
  const back = evaluate(poses, undefined, 'back').byId['trophy-knee'];
  near(side.value, back.value, 1e-9);            // 測った値は同じ
  assert.equal(side.status, 'good');             // 横からなら、プロでもこのくらいに見える
  assert.equal(back.status, 'hint');             // 後ろからだと、もっと深く見えるはず
  assert.match(side.target, /155° 以下（横からは浅く見えます）/);
  assert.match(back.target, /120° 以下$/);
});

test('プロの参考値（同梱の集計結果）は、どの項目も目安の「良い」に入る', async () => {
  const { readFile } = await import('node:fs/promises');
  const file = new URL('../docs/data/pro-reference.json', import.meta.url);
  const reference = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(reference.source.license, 'CC BY 4.0');
  // 選手を特定する項目は入れない（"players" は人数なので可）
  assert.doesNotMatch(JSON.stringify(reference), /"player"|"server"|"name"/, '選手名は入れない');
  for (const view of ['side', 'back']) {
    for (const group of ['men', 'women']) {
      const checks = reference.views[view][group].checks;
      for (const check of CHECKS) {
        const c = checks[check.id];
        assert.ok(c && c.players >= 30, `${view} ${group} ${check.id}`);
        assert.ok(c.p25 <= c.p50 && c.p50 <= c.p75);
        if (check.id === 'impact-contact') continue; // 参考値なので良し悪しはない
        // 半数の選手が入る範囲の両端とも「良い」になること
        for (const v of [c.p25, c.p50, c.p75]) {
          assert.equal(check.judge(v, view).status, 'good', `${view} ${group} ${check.id} = ${v}`);
        }
      }
    }
  }
});

// 打点の位置を確かめるための、インパクトの姿勢だけの点の組
function impactPose({ wristX, noseX = 0.5, ankleX = 0.5, hitShoulderX = 0.56, oppShoulderX = 0.44, mirror = false }) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0 }));
  const m = (x) => (mirror ? 1 - x : x);
  const put = (i, x, y) => { pts[i] = { x: m(x), y, v: 1 }; };
  put(LM.NOSE, noseX, 0.2);
  put(LM.L_ANKLE, ankleX - 0.03, 0.9); put(LM.R_ANKLE, ankleX + 0.03, 0.9);
  put(LM.R_SHOULDER, hitShoulderX, 0.3); put(LM.L_SHOULDER, oppShoulderX, 0.3);
  put(LM.R_WRIST, wristX, 0.02);
  return pts;
}

test('打点の位置：横からは前が正、後ろからは利き腕側が正。左右を反転しても同じ値', () => {
  // 横から：頭が足より 0.05 前（画面右）に出ていて、手首は頭より 0.07 前。体の高さ 0.7 → +10%
  const side = { wristX: 0.57, noseX: 0.5, ankleX: 0.45 };
  near(contactOffset(impactPose(side), 'right', 'side'), 0.1, 1e-9);
  near(contactOffset(impactPose({ ...side, mirror: true }), 'right', 'side'), 0.1, 1e-9);
  near(contactOffset(impactPose({ ...side, wristX: 0.465 }), 'right', 'side'), -0.05, 1e-9); // 頭より後ろ

  // 後ろから：打つ側の肩が画面右。手首が頭より 0.07 右 → +10%、0.035 左 → −5%
  const back = { wristX: 0.57 };
  near(contactOffset(impactPose(back), 'right', 'back'), 0.1, 1e-9);
  near(contactOffset(impactPose({ ...back, mirror: true }), 'right', 'back'), 0.1, 1e-9);
  near(contactOffset(impactPose({ wristX: 0.465 }), 'right', 'back'), -0.05, 1e-9);

  // 向きを決められない（頭が足の真上／手首や足首が見えない）ときは null
  assert.equal(contactOffset(impactPose({ wristX: 0.57 }), 'right', 'side'), null);
  const hidden = impactPose(side);
  hidden[LM.R_WRIST].v = 0;
  assert.equal(contactOffset(hidden, 'right', 'side'), null);
  assert.equal(contactOffset(null, 'right', 'side'), null);
});

test('「打点の位置」は良し悪しを決めない参考項目で、選んだ種類の一般的な傾向を添える', () => {
  const check = CHECKS.find((c) => c.id === 'impact-contact');
  const flat = check.judge(10.4, 'side', 'flat');
  assert.equal(flat.status, 'info');
  assert.match(flat.text, /頭より 10% 前（ネット側）で打っています。フラットは、頭より前/);
  assert.match(check.judge(-6, 'side', 'spin').text, /頭より 6% 後ろで打っています。スピンは/);
  assert.match(check.judge(14, 'back', 'slice').text, /頭より 14% 利き腕側で打っています。スライスは/);
  assert.match(check.judge(-3, 'back', 'spin').text, /頭より 3% 反対側で打っています。スピンは/);
  assert.equal(check.judge(8, 'side', 'unset').text, '頭より 8% 前（ネット側）で打っています。');
  assert.match(check.target('side'), /前へのずれ/);
  assert.match(check.target('back'), /利き腕側へのずれ/);
  assert.deepEqual(Object.keys(SERVE_TYPES), ['unset', 'flat', 'slice', 'spin']);
});

test('参考項目は「目安どおり」の数に入れない', () => {
  const results = [{ status: 'good' }, { status: 'hint' }, { status: 'info' }, { status: 'na' }];
  assert.deepEqual(summarize(results), { measured: 2, good: 1, total: 4 });
});
