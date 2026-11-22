// サーブ フォームチェック：動画を端末内で骨格解析し、角度を見える化する。
// 動画はどこにも送らない。外から読み込むのは骨格モデル（MediaPipe）だけ。

import {
  METRICS, BONES, JOINTS, LM, armOf, toPoints, buildSeries, findServes, serveAt,
  valueAt, poseAt, nearestIndex, frameStep, missingTimes,
} from './pose-math.js';
import { evaluateServe, summarize, VIEWS } from './coaching.js';
import { LineChart } from './chart.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const SLOT_NAMES = ['A', 'B'];
const RATES = [1, 0.5, 0.25, 0.1];
const ANALYZE_RATE = 0.5;     // 解析を始めるときの再生速度（あとは端末の速さに合わせて変える）
const ANALYZE_RATE_MIN = 0.1;
const ANALYZE_RATE_MAX = 1;
const ADAPT_EVERY = 8;        // 何コマごとに再生速度を見直すか
const SPARSE_FPS = 10;        // 読み取れたコマが 1 秒あたりこれ未満なら、少ないと知らせる
const STALL_MS = 5000;        // 再生中にこれだけコマが来なければ、再生で読むのを切り上げる
const STARVE_MS = 2500;       // 最初のコマを読んでからこの時間で
const STARVE_FRAMES = 5;      // これだけのコマしか来ていなければ、同じく切り上げる
const FRAME_WAIT_MS = 60;     // 頭出しのあと、絵が切り替わるのを待つ上限
const SEEK_TIMEOUT_MS = 3000; // 頭出しそのものを待つ上限
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const ZOOM_BEFORE = 2.0;      // グラフ「サーブ前後」の範囲：インパクトの何秒前から
const ZOOM_AFTER = 1.0;       // 〜何秒後まで
const EPS = 0.001;            // コマの時刻ちょうどに飛ぶと 1 つ前が出ることがあるので少し足す
const DRAW_MIN_VIS = 0.3;

const BODY_COLOR = '#7cf3c5';
const ARM_COLOR = '#ffd23f';

class UserError extends Error {}
class Cancelled extends Error {}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const dom = {
  msg: $('#msg'),
  start: $('#start'),
  work: $('#work'),
  stages: $('#stages'),
  alignNote: $('#align-note'),
  panels: $('#panels'),
  file: $('#file'),
  pick: $('#pick'),
  add: $('#add'),
  hand: $('#hand'),
  view: $('#view'),
  play: $('#play'),
  prev: $('#prev'),
  next: $('#next'),
  seek: $('#seek'),
  time: $('#time'),
  rates: $('#rates'),
  showPose: $('#show-pose'),
  jumpTrophy: $('#jump-trophy'),
  jumpImpact: $('#jump-impact'),
  serveNote: $('#serve-note'),
  coachSlot: $('#coach-slot'),
  coachSummary: $('#coach-summary'),
  coachList: $('#coach-list'),
  tableTitle: $('#table-title'),
  tableNote: $('#table-note'),
  table: $('#metrics'),
  metric: $('#metric'),
  zoom: $('#zoom'),
  legend: $('#legend'),
  chart: $('#chart'),
};

const state = {
  hand: readPref('hand') === 'left' ? 'left' : 'right',
  view: readPref('view') in VIEWS ? readPref('view') : 'side', // 撮った向き（横から / 後ろから）
  rate: 0.25,
  playing: false,
  busy: false,
  showPose: true,
  coachSlot: 0,       // フォームのチェックを表示する動画（0 = A、1 = B）
  metric: 'elbow',
  zoom: 'serve',
};

/** @type {[Clip | null, Clip | null]} */
const clips = [null, null];
let pendingSlot = 0;
let proReference = null;  // プロの参考値（data/pro-reference.json）。読めなければ null のまま、参考値なしで動く
let liveCells = [];       // 表のうち、再生位置に合わせて書き換えるセル
let lastSeekTime = -1;

function readPref(key) {
  try { return localStorage.getItem(`tennis-form:${key}`); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(`tennis-form:${key}`, value); } catch { /* 保存できなくても動作には影響しない */ }
}

// ---------------------------------------------------------------- 骨格モデル

let landmarkerPromise = null;
let lastTimestamp = 0; // モデルに渡す時刻は、動画をまたいでも増え続けなければならない

function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker().catch((e) => {
      landmarkerPromise = null; // 次の動画でもう一度試せるようにする
      throw e;
    });
  }
  return landmarkerPromise;
}

async function createLandmarker() {
  let vision, fileset;
  try {
    vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  } catch (e) {
    console.error(e);
    throw new UserError('骨格モデルを読み込めませんでした。通信状態を確認して、もう一度試してください。');
  }
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    return await vision.PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (gpuError) {
    console.warn('GPU で動かせないため CPU に切り替えます', gpuError);
    try {
      return await vision.PoseLandmarker.createFromOptions(fileset, options('CPU'));
    } catch (e) {
      console.error(e);
      throw new UserError('骨格モデルを読み込めませんでした。通信状態を確認して、もう一度試してください。');
    }
  }
}

// 動画の新しいコマが画面に出るたびに cb(そのコマの時刻) を呼ぶ。戻り値で止められる。
function eachVideoFrame(video, cb) {
  let stopped = false;
  if (HAS_RVFC) {
    const tick = (_now, meta) => {
      if (stopped) return;
      cb(meta.mediaTime);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    let last = -1;
    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.currentTime !== last) {
        last = video.currentTime;
        cb(last);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  return () => { stopped = true; };
}

// 指定の時刻に頭出しし、そのコマが読める状態になるまで待つ
function seekAndWait(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    const onSeeked = () => {
      // 頭出しが済んでも絵が切り替わるまで一瞬かかる端末がある。表示の合図を待ち、来なければ先へ進む。
      if (HAS_RVFC) video.requestVideoFrameCallback(done);
      setTimeout(done, FRAME_WAIT_MS);
    };
    const guard = setTimeout(done, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = t;
  });
}

// ブラウザで録画した動画などは長さが不明（Infinity）のことがある。末尾まで飛ばすと確定する。
async function settleDuration(video) {
  if (Number.isFinite(video.duration)) return;
  await new Promise((resolve) => {
    const check = () => {
      if (!Number.isFinite(video.duration)) return;
      video.removeEventListener('durationchange', check);
      resolve();
    };
    video.addEventListener('durationchange', check);
    setTimeout(resolve, 3000);
    video.currentTime = 1e101;
  });
  await new Promise((resolve) => {
    video.addEventListener('seeked', resolve, { once: true });
    setTimeout(resolve, 1000);
    video.currentTime = 0;
  });
}

// ---------------------------------------------------------------- 動画 1 本ぶん

const CLIP_HTML = `
  <header class="clip-head">
    <span class="badge"></span>
    <span class="clip-name"></span>
    <span class="clip-actions">
      <button type="button" class="link" data-act="replace">替える</button>
      <button type="button" class="link" data-act="remove">外す</button>
    </span>
  </header>
  <div class="stage" data-act="toggle">
    <video playsinline muted preload="auto" disablepictureinpicture></video>
    <canvas aria-hidden="true"></canvas>
    <div class="veil" hidden>
      <p class="veil-text"></p>
      <progress max="1" value="0"></progress>
      <div class="veil-actions">
        <button type="button" class="btn small primary" data-act="start" hidden>▶ 解析を始める</button>
        <button type="button" class="btn small" data-act="cancel">中止</button>
      </div>
    </div>
  </div>
  <div class="clip-foot" hidden>
    <div class="serves" role="group" aria-label="サーブを選ぶ"></div>
    <button type="button" class="link" data-act="set-impact">いまの位置をインパクトにする</button>
    <p class="clip-note muted small" hidden></p>
  </div>`;

class Clip {
  constructor(slot) {
    this.el = document.createElement('article');
    this.el.className = 'clip';
    this.el.innerHTML = CLIP_HTML;
    this.video = $('video', this.el);
    this.canvas = $('canvas', this.el);
    this.ctx = this.canvas.getContext('2d');
    this.veil = $('.veil', this.el);
    this.veilText = $('.veil-text', this.el);
    this.progress = $('progress', this.el);
    this.startBtn = $('[data-act="start"]', this.el);
    this.foot = $('.clip-foot', this.el);
    this.servesEl = $('.serves', this.el);
    this.note = $('.clip-note', this.el);

    this.frames = [];
    this.series = null;
    this.serves = [];
    this.sel = 0;
    this.dur = 0;
    this.portrait = false;
    this.ready = false;
    this.analyzing = false;
    this.cancelled = false;
    this.abort = null;          // 解析を途中で止める関数（解析中だけ入る）
    this.onAnalyzeFrame = null; // 解析中だけ入る。コマを受け取って骨格を読む
    this.livePts = null;
    this.shownT = 0;            // いま画面に出ているコマの時刻
    this.dirty = true;
    this.url = null;

    this.setSlot(slot);
    this.el.addEventListener('click', (e) => this.onClick(e));
    for (const type of ['play', 'pause', 'ended']) {
      this.video.addEventListener(type, () => onPlayStateChange(this));
    }
    this.video.addEventListener('seeked', () => {
      if (this.analyzing) return;
      this.shownT = this.video.currentTime;
      this.dirty = true;
    });
    this.stopFrames = eachVideoFrame(this.video, (t) => {
      if (this.onAnalyzeFrame) { this.onAnalyzeFrame(t); return; }
      this.shownT = t;
      this.dirty = true;
    });
  }

  setSlot(slot) {
    this.slot = slot;
    this.el.dataset.slot = String(slot);
    $('.badge', this.el).textContent = SLOT_NAMES[slot];
  }

  get serve() { return this.serves[this.sel] ?? null; }

  /** 'impact' | 'trophy' の時刻（秒）。なければ null */
  timeOf(key) {
    const i = this.serve?.[key];
    return i == null ? null : this.frames[i].t;
  }

  onClick(e) {
    const target = e.target.closest('[data-act]');
    if (!target || !this.el.contains(target)) return;
    const act = target.dataset.act;
    if (act === 'cancel') this.cancel();
    else if (act === 'start') { this.startBtn.hidden = true; this.video.play().catch(() => { this.startBtn.hidden = false; }); }
    else if (state.busy) return;
    else if (act === 'replace') pickFile(this.slot);
    else if (act === 'remove') { pause(); dropClip(this.slot); render(); }
    else if (act === 'toggle') togglePlay();
    else if (act === 'set-impact') this.setImpactHere();
    else if (act === 'serve') { this.sel = Number(target.dataset.index); render(); jump('impact'); }
  }

  showVeil(text, progress) {
    this.veil.hidden = false;
    this.veilText.textContent = text;
    this.progress.hidden = progress == null;
    if (progress != null) this.progress.value = progress;
  }

  async load(file) {
    const v = this.video;
    $('.clip-name', this.el).textContent = file.name;
    this.showVeil('動画を読み込んでいます…', null);
    this.url = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      const fail = () => { cleanup(); reject(new UserError('この動画は再生できませんでした。MP4 など別の形式で試してください。')); };
      const ok = () => { cleanup(); resolve(); };
      const timer = setTimeout(fail, 20000);
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', fail);
      };
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', fail);
      v.src = this.url;
      v.load();
    });
    if (!v.videoWidth || !v.videoHeight) throw new UserError('映像が入っていないファイルです。');
    await settleDuration(v);
    this.portrait = v.videoHeight > v.videoWidth;
    this.el.style.setProperty('--ar', String(v.videoWidth / v.videoHeight));
  }

  // 解析は 2 段階。
  //   1) 動画を再生しながら、画面に出たコマを順に読む（速い）
  //   2) 端末が遅い・画面が隠れたなどで抜けた区間を、1 コマずつ頭出しして読み直す（確実）
  async analyze() {
    const v = this.video;
    this.analyzing = true;
    try {
      this.showVeil('骨格モデルを読み込んでいます…（初回は少し時間がかかります）', null);
      const landmarker = await getLandmarker();
      if (this.cancelled) throw new Cancelled();

      const aspect = v.videoWidth / v.videoHeight;
      const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      const frames = [];
      const base = lastTimestamp + 1000;
      const detect = (t, inOrder) => {
        // モデルに渡す時刻は増え続けなければならない。順に読むときは動画の時刻をそのまま使い、
        // 読み直しで前後するときは 1 コマぶんずつ進める。
        lastTimestamp = inOrder ? Math.max(lastTimestamp + 1, Math.round(base + t * 1000)) : lastTimestamp + 34;
        const found = landmarker.detectForVideo(v, lastTimestamp).landmarks?.[0];
        const pts = found ? toPoints(found, aspect) : null;
        frames.push({ t, pts });
        this.livePts = pts;
        this.draw(t);
      };

      v.loop = false;
      v.muted = true;
      this.showVeil('骨格を読み取っています…', 0);
      const minGap = await this.readWhilePlaying(detect, frames, total);
      if (this.cancelled) throw new Cancelled();

      const step = clamp(Number.isFinite(minGap) ? minGap : 1 / 30, 1 / 30, 1 / 15);
      const missing = missingTimes(frames.map((f) => f.t), total, step);
      if (missing.length) {
        this.showVeil('抜けたコマを読み直しています…', 0);
        for (let i = 0; i < missing.length; i++) {
          await seekAndWait(v, missing[i]);
          if (this.cancelled) throw new Cancelled();
          detect(missing[i], false);
          this.progress.value = (i + 1) / missing.length;
        }
        frames.sort((a, b) => a.t - b.t);
      }

      const found = frames.filter((f) => f.pts).length;
      const seconds = frames.length ? frames[frames.length - 1].t : 0;
      const perSecond = seconds > 0 ? frames.length / seconds : 0;
      console.info('[解析]', { frames: frames.length, found, reread: missing.length, seconds, perSecond });
      if (frames.length < 8) {
        throw new UserError('動画のコマをほとんど読み取れませんでした。別の動画で試してください。');
      }
      if (found < frames.length * 0.3) {
        throw new UserError('人物をうまく読み取れませんでした。全身が映っている明るい動画で試してください。');
      }
      this.frames = frames;
      this.dur = total ?? seconds;
      this.note.hidden = perSecond >= SPARSE_FPS;
      this.note.textContent = `読み取れたコマが少なめです（1 秒あたり約 ${perSecond.toFixed(0)} コマ）。`;
      this.recompute();
      this.ready = true;
      this.veil.hidden = true;
    } finally {
      this.analyzing = false;
      this.livePts = null;
      this.dirty = true;
    }
  }

  /** 1 段階目：再生しながら読む。戻り値は、連続して読めたコマの最小間隔（秒） */
  readWhilePlaying(detect, frames, total) {
    const v = this.video;
    let lastT = -1, minGap = Infinity, recentMs = 0, recentCount = 0;
    let lastFrameAt = performance.now(), firstReadAt = null, waitingForTap = false;
    v.playbackRate = ANALYZE_RATE;

    return new Promise((resolve, reject) => {
      const finish = (error) => {
        this.onAnalyzeFrame = null;
        this.abort = null;
        clearInterval(watchdog);
        v.removeEventListener('ended', onEnded);
        v.removeEventListener('error', onError);
        v.removeEventListener('playing', onPlaying);
        document.removeEventListener('visibilitychange', onVisibility);
        v.pause();
        if (error) reject(error); else resolve(minGap);
      };
      const onEnded = () => finish();
      const onError = () => finish(new UserError('動画の再生中にエラーが起きました。'));
      const onPlaying = () => {
        waitingForTap = false;
        this.startBtn.hidden = true;
        lastFrameAt = performance.now();
      };
      const onVisibility = () => {
        if (document.hidden) v.pause();
        else if (!waitingForTap) { lastFrameAt = performance.now(); v.play().catch(() => {}); }
      };
      // コマがほとんど来ない（描画が間引かれている）なら、再生で読むのを切り上げて 2 段階目に任せる。
      // 最初の 1 コマはモデルの準備で時間がかかるので、それが済んでから数え始める。
      const watchdog = setInterval(() => {
        if (document.hidden || waitingForTap) return;
        const now = performance.now();
        const starved = firstReadAt != null && now - firstReadAt > STARVE_MS && frames.length <= STARVE_FRAMES;
        if (starved || now - lastFrameAt > STALL_MS) finish();
      }, 500);

      this.abort = () => finish(new Cancelled());
      this.onAnalyzeFrame = (t) => {
        lastFrameAt = performance.now();
        if (t <= lastT) return;
        if (lastT >= 0) minGap = Math.min(minGap, t - lastT);
        lastT = t;
        try {
          detect(t, true);
        } catch (e) {
          finish(e);
          return;
        }
        firstReadAt ??= performance.now();
        if (total) this.progress.value = Math.min(1, t / total);

        // 端末の速さに合わせて再生速度を変え、コマを取りこぼさないようにする。
        // 1 コマの処理時間（の 1.25 倍）が、動画の 1 コマぶんの実時間に収まる速度にする。
        recentMs += performance.now() - lastFrameAt;
        recentCount += 1;
        if (recentCount === ADAPT_EVERY && Number.isFinite(minGap)) {
          const want = clamp((minGap * 1000) / ((recentMs / recentCount) * 1.25), ANALYZE_RATE_MIN, ANALYZE_RATE_MAX);
          if (Math.abs(want - v.playbackRate) > v.playbackRate * 0.15) v.playbackRate = Math.round(want * 100) / 100;
          recentMs = 0;
          recentCount = 0;
        }
      };

      v.addEventListener('ended', onEnded);
      v.addEventListener('error', onError);
      v.addEventListener('playing', onPlaying);
      document.addEventListener('visibilitychange', onVisibility);
      v.play().catch((e) => {
        if (e?.name === 'NotAllowedError') {
          // 省電力モードなどで自動再生が止められた。ボタンを押してもらえば始められる。
          waitingForTap = true;
          this.showVeil('下のボタンを押すと解析を始めます。', null);
          this.startBtn.hidden = false;
        } else if (e?.name !== 'AbortError') {
          finish(e);
        }
      });
    });
  }

  cancel() {
    this.cancelled = true;
    this.abort?.();
  }

  /** 利き手が変わったときなどに、角度とサーブ位置を計算し直す */
  recompute() {
    this.series = buildSeries(this.frames, state.hand);
    this.serves = findServes(this.frames, state.hand);
    this.sel = 0;
  }

  setImpactHere() {
    if (!this.ready) return;
    const serve = serveAt(this.frames, nearestIndex(this.frames, this.shownT));
    if (this.serves.length) this.serves[this.sel] = serve;
    else { this.serves = [serve]; this.sel = 0; }
    render();
    jump('impact');
  }

  renderFoot() {
    this.foot.hidden = !this.ready;
    if (!this.ready) return;
    this.servesEl.replaceChildren();
    if (this.serves.length > 1) {
      this.serves.forEach((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.act = 'serve';
        b.dataset.index = String(i);
        b.setAttribute('aria-pressed', String(i === this.sel));
        b.textContent = `サーブ ${i + 1}`;
        this.servesEl.append(b);
      });
    }
  }

  draw(t) {
    const { canvas, ctx } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.showPose) return;
    const pts = this.analyzing ? this.livePts : poseAt(this.frames, t);
    if (!pts) return;
    drawSkeleton(ctx, pts, h);
    if (this.ready) drawAngleTags(ctx, pts, h, w, (id) => valueAt(this.frames, this.series[id], t));
  }

  dispose() {
    this.cancel();
    this.stopFrames();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.el.remove();
  }
}

// ---------------------------------------------------------------- 骨格の描画

const drawable = (p) => !!p && p.v >= DRAW_MIN_VIS;

function drawSkeleton(ctx, pts, H) {
  const arm = armOf(state.hand);
  const isArm = (a, b) => (a === arm.shoulder && b === arm.elbow) || (a === arm.elbow && b === arm.wrist);
  const width = Math.max(2.5, H / 150);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 背景がどんな色でも見えるよう、暗い縁取り → 色の順に 2 回描く
  for (const pass of [0, 1]) {
    for (const [a, b] of BONES) {
      const p = pts[a], q = pts[b];
      if (!drawable(p) || !drawable(q)) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * H, p.y * H);
      ctx.lineTo(q.x * H, q.y * H);
      if (pass === 0) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = width + 3;
      } else {
        ctx.strokeStyle = isArm(a, b) ? ARM_COLOR : BODY_COLOR;
        ctx.lineWidth = width;
      }
      ctx.stroke();
    }
  }
  for (const i of JOINTS) {
    const p = pts[i];
    if (!drawable(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x * H, p.y * H, width * 1.1, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.stroke();
  }
}

// 肘と両膝の横に角度を書く
function drawAngleTags(ctx, pts, H, W, valueOf) {
  const arm = armOf(state.hand);
  const tags = [
    [arm.elbow, valueOf('elbow')],
    [LM.L_KNEE, valueOf('kneeL')],
    [LM.R_KNEE, valueOf('kneeR')],
  ];
  const hips = [pts[LM.L_HIP], pts[LM.R_HIP]].filter(drawable);
  const centerX = hips.length ? hips.reduce((s, p) => s + p.x, 0) / hips.length : null;
  const size = clamp(Math.round(H / 32), 11, 15);
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const [index, value] of tags) {
    const p = pts[index];
    if (value == null || !drawable(p)) continue;
    const text = `${Math.round(value)}°`;
    const tw = ctx.measureText(text).width + 10, th = size + 8;
    // 体の中心から離れる側に置く
    const outward = centerX == null || p.x >= centerX ? 1 : -1;
    let x = p.x * H + (outward > 0 ? 10 : -10 - tw);
    let y = p.y * H - th / 2;
    x = clamp(x, 2, W - tw - 2);
    y = clamp(y, 2, H - th - 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, tw, th, 6); else ctx.rect(x, y, tw, th);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + 5, y + th / 2 + 0.5);
  }
}

// ---------------------------------------------------------------- 動画の出し入れ

function pickFile(slot) {
  if (state.busy) return;
  pendingSlot = slot;
  dom.file.value = '';
  dom.file.click();
}

async function loadFile(slot, file) {
  if (state.busy || !file) return;
  showMessage('');
  pause();
  state.busy = true;

  const old = clips[slot];
  const clip = new Clip(slot);
  if (old) { old.el.replaceWith(clip.el); old.dispose(); } else dom.stages.append(clip.el);
  clips[slot] = clip;
  render();

  try {
    await clip.load(file);
    render(); // 縦長・横長が分かったので並べ方を直す
    await clip.analyze();
  } catch (e) {
    dropClip(clips.indexOf(clip));
    if (!(e instanceof Cancelled)) {
      if (!(e instanceof UserError)) console.error(e);
      showMessage(e instanceof UserError ? e.message : `解析に失敗しました（${e?.message ?? e}）。`);
    }
  } finally {
    state.busy = false;
    render();
  }
  if (clip.ready && clips.includes(clip)) {
    if (clips[0].timeOf('impact') != null) jump('impact'); else seekTo(0);
  }
}

function dropClip(slot) {
  const clip = clips[slot];
  if (!clip) return;
  clip.dispose();
  clips[slot] = null;
  if (slot === 0 && clips[1]) { // B だけ残ったら A に繰り上げる
    clips[0] = clips[1];
    clips[1] = null;
    clips[0].setSlot(0);
  }
}

function showMessage(text) {
  dom.msg.textContent = text;
  dom.msg.hidden = !text;
}

// ---------------------------------------------------------------- 再生

// B の時刻 = A の時刻 + offset()。両方にインパクトがあれば、その瞬間をそろえる。
function offset() {
  const ia = clips[0]?.timeOf('impact'), ib = clips[1]?.timeOf('impact');
  return ia != null && ib != null ? ib - ia : 0;
}

function setTime(video, t) {
  try { video.currentTime = t; } catch { /* 読み込み前は無視 */ }
}

/** A の時刻 t に移動する（B は連動） */
function seekTo(t) {
  const a = clips[0];
  if (!a?.ready) return;
  t = clamp(t, 0, a.dur);
  setTime(a.video, t);
  const b = clips[1];
  if (b?.ready) setTime(b.video, clamp(t + offset(), 0, b.dur));
}

/** トロフィーポーズ／インパクトへ飛ぶ。B は B 自身のその瞬間へ */
function jump(key) {
  const a = clips[0];
  const ta = a?.ready ? a.timeOf(key) : null;
  if (ta == null) return;
  pause();
  setTime(a.video, ta + EPS);
  const b = clips[1];
  if (b?.ready) {
    const tb = b.timeOf(key);
    setTime(b.video, tb != null ? tb + EPS : clamp(ta + offset(), 0, b.dur));
  }
}

function step(dir) {
  const a = clips[0];
  if (!a?.ready || state.busy) return;
  pause();
  const i = clamp(nearestIndex(a.frames, a.shownT) + dir, 0, a.frames.length - 1);
  seekTo(a.frames[i].t + EPS);
}

function play() {
  const a = clips[0];
  if (!a?.ready || state.busy) return;
  if (a.video.currentTime >= a.dur - 0.05) seekTo(0);
  for (const c of clips) if (c?.ready) c.video.playbackRate = state.rate;
  a.video.play().catch(() => {});
}

function pause() {
  for (const c of clips) if (c && !c.analyzing) c.video.pause();
}

function togglePlay() {
  if (state.playing) pause(); else play();
}

function onPlayStateChange(clip) {
  if (clip.slot !== 0 || clip.analyzing) return;
  state.playing = !clip.video.paused && !clip.video.ended;
  if (!state.playing) clips[1]?.video.pause();
  renderPlayButton();
}

// 再生中、B を A に合わせ続ける
function syncB() {
  const a = clips[0], b = clips[1];
  if (!a?.ready || !b?.ready) return;
  const bv = b.video;
  const target = a.video.currentTime + offset();
  if (target < 0 || target > b.dur) {
    if (!bv.paused) bv.pause();
    const edge = target < 0 ? 0 : b.dur;
    if (!bv.seeking && Math.abs(bv.currentTime - edge) > 0.03) setTime(bv, edge);
  } else if (bv.paused) {
    setTime(bv, target);
    bv.playbackRate = state.rate;
    bv.play().catch(() => {});
  } else if (!bv.seeking && Math.abs(bv.currentTime - target) > 0.12) {
    setTime(bv, target);
  }
}

// ---------------------------------------------------------------- 表示の組み立て

function formatValue(metric, v) {
  return v == null ? '—' : `${v.toFixed(metric.digits)}${metric.unit}`;
}
function formatDiff(metric, v) {
  if (v == null) return '—';
  const text = Math.abs(v).toFixed(metric.digits);
  if (Number(text) === 0) return `±${text}${metric.unit}`;
  return `${v > 0 ? '+' : '−'}${text}${metric.unit}`;
}

function render() {
  const a = clips[0], b = clips[1];
  const ready = !!a?.ready && !state.busy;

  dom.start.hidden = !!a;
  dom.work.hidden = !a;
  dom.panels.hidden = !a?.ready;
  dom.stages.classList.toggle('two', !!b);
  dom.stages.classList.toggle('portrait', clips.every((c) => !c || c.portrait));
  for (const c of clips) c?.renderFoot();

  for (const node of $$('[data-ctl]')) node.disabled = !ready;
  dom.add.hidden = !!b;
  dom.add.disabled = !ready;
  for (const node of $$('button', dom.hand)) {
    node.setAttribute('aria-pressed', String(node.dataset.hand === state.hand));
    node.disabled = state.busy;
  }
  for (const node of $$('button', dom.view)) {
    node.setAttribute('aria-pressed', String(node.dataset.view === state.view));
  }

  renderAlignNote();
  renderTransport();
  renderCoach();
  renderTable();
  renderChart();
  for (const c of clips) if (c) c.dirty = true;
  lastSeekTime = -1;
}

function renderAlignNote() {
  const a = clips[0], b = clips[1];
  const both = !!a?.ready && !!b?.ready;
  dom.alignNote.hidden = !both;
  if (!both) return;
  dom.alignNote.textContent = a.timeOf('impact') != null && b.timeOf('impact') != null
    ? 'A と B は、インパクトの瞬間をそろえて再生します。'
    : 'インパクトが見つかっていない動画があるため、動画の先頭をそろえて再生します。';
}

function renderPlayButton() {
  dom.play.textContent = state.playing ? '⏸ 一時停止' : '▶ 再生';
}

function renderTransport() {
  const a = clips[0];
  renderPlayButton();
  for (const node of $$('button', dom.rates)) {
    node.setAttribute('aria-pressed', String(Number(node.dataset.rate) === state.rate));
  }
  dom.showPose.checked = state.showPose;
  if (!a?.ready) return;
  dom.seek.max = String(a.dur);
  const hasImpact = a.timeOf('impact') != null, hasTrophy = a.timeOf('trophy') != null;
  if (!state.busy) {
    dom.jumpImpact.disabled = !hasImpact;
    dom.jumpTrophy.disabled = !hasTrophy;
  }
  dom.serveNote.hidden = hasImpact;
}

const STATUS_LABEL = { good: ['◎', '良い'], hint: ['△', '見直し'], na: ['—', '測れず'] };

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// その項目の、プロの参考値の 1 行。「男子 98°（92〜102°）・女子 102°（97〜107°）」
function proLine(result) {
  const groups = proReference?.views?.[state.view];
  if (!groups) return '';
  const fmt = (v) => `${v.toFixed(result.digits)}${result.unit}`;
  const parts = [];
  for (const [id, label] of [['men', '男子'], ['women', '女子']]) {
    const c = groups[id]?.checks?.[result.id];
    if (c) parts.push(`${label} ${fmt(c.p50)}（${fmt(c.p25)}〜${fmt(c.p75)}）`);
  }
  return parts.length ? `プロ　${parts.join('・')}` : '';
}

// 目安と比べた結果（定型コメント）を並べる
function renderCoach() {
  const a = clips[0]?.ready ? clips[0] : null;
  const b = clips[1]?.ready ? clips[1] : null;
  if (!b) state.coachSlot = 0;
  const clip = state.coachSlot === 1 ? b : a;

  dom.coachSlot.hidden = !b;
  for (const btn of $$('button', dom.coachSlot)) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.slot) === state.coachSlot));
  }
  dom.coachList.replaceChildren();
  if (!clip) { dom.coachSummary.textContent = ''; return; }
  if (!clip.serve) {
    dom.coachSummary.textContent = 'インパクトの位置が決まると、フォームをチェックできます。';
    return;
  }

  const results = evaluateServe({ frames: clip.frames, series: clip.series, serve: clip.serve, view: state.view });
  const { measured, good } = summarize(results);
  dom.coachSummary.textContent = measured
    ? `測れた ${measured} 項目のうち、${good} 項目が目安どおりです。`
    : 'この動画では、どの項目も測れませんでした。全身が映るように撮ると測れます。';

  for (const moment of ['trophy', 'impact']) {
    const items = results.filter((r) => r.moment === moment);
    const group = node('div', 'coach-group');
    const head = node('div', 'coach-group-head');
    head.append(node('h3', '', items[0].momentLabel));
    if (clip.timeOf(moment) != null) {
      const jumpBtn = node('button', 'link', 'この瞬間を見る');
      jumpBtn.type = 'button';
      jumpBtn.dataset.jump = moment;
      head.append(jumpBtn);
    }
    const list = node('ul', 'coach-items');
    for (const r of items) {
      const [mark, label] = STATUS_LABEL[r.status];
      const li = node('li', `coach-item is-${r.status}`);
      const status = node('span', 'coach-status');
      const icon = node('span', '', mark);
      icon.setAttribute('aria-hidden', 'true');
      status.append(icon, ` ${label}`);
      const body = node('div', 'coach-body');
      const title = node('p', 'coach-title');
      title.append(node('span', 'coach-name', r.title));
      if (r.status !== 'na') title.append(node('span', 'coach-value', r.valueText));
      title.append(node('span', 'coach-target', r.target));
      body.append(title, node('p', 'coach-text', r.text));
      const pro = proLine(r);
      if (pro) body.append(node('p', 'coach-pro', pro));
      li.append(status, body);
      list.append(li);
    }
    group.append(head, list);
    dom.coachList.append(group);
  }
}

function renderTable() {
  const a = clips[0]?.ready ? clips[0] : null;
  const b = clips[1]?.ready ? clips[1] : null;
  liveCells = [];
  dom.table.replaceChildren();
  if (!a) return;

  const nowOf = (clip, metric) => valueAt(clip.frames, clip.series[metric.id], clip.shownT);
  const keyOf = (clip, metric, key) => {
    const i = clip.serve?.[key];
    return i == null ? null : clip.series[metric.id][i];
  };
  /** @type {{ head: string, cls?: string, live: boolean, text: (m: object) => string }[]} */
  let columns;
  if (b) {
    dom.tableTitle.textContent = 'いまの位置の数値（A と B）';
    dom.tableNote.textContent = '「トロフィーポーズ」「インパクト」のボタンを押すと、その瞬間どうしを比べられます。差は B − A です。';
    columns = [
      { head: 'A', cls: 'col-a', live: true, text: (m) => formatValue(m, nowOf(a, m)) },
      { head: 'B', cls: 'col-b', live: true, text: (m) => formatValue(m, nowOf(b, m)) },
      {
        head: '差', live: true,
        text: (m) => {
          const va = nowOf(a, m), vb = nowOf(b, m);
          if (va == null || vb == null) return formatDiff(m, null);
          // 表に出ている（丸めた）数字どうしの差にする。そうしないと 5° と 5° の差が +1° になることがある
          return formatDiff(m, Number(vb.toFixed(m.digits)) - Number(va.toFixed(m.digits)));
        },
      },
    ];
  } else {
    dom.tableTitle.textContent = '角度の数値';
    dom.tableNote.textContent = '「いま」は動画の現在位置の値です。';
    columns = [
      { head: 'いま', live: true, text: (m) => formatValue(m, nowOf(a, m)) },
      { head: 'トロフィー', live: false, text: (m) => formatValue(m, keyOf(a, m, 'trophy')) },
      { head: 'インパクト', live: false, text: (m) => formatValue(m, keyOf(a, m, 'impact')) },
    ];
  }

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const first = document.createElement('th');
  first.scope = 'col';
  first.textContent = '項目';
  headRow.append(first);
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'num';
    if (col.cls) {
      const sw = document.createElement('i');
      sw.className = `sw ${col.cls}`;
      th.append(sw);
    }
    th.append(col.head);
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const metric of METRICS) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = metric.label;
    const hint = document.createElement('span');
    hint.className = 'm-hint';
    hint.textContent = metric.hint;
    th.append(name, hint);
    tr.append(th);
    for (const col of columns) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = col.text(metric);
      if (col.live) liveCells.push({ td, metric, text: col.text });
      tr.append(td);
    }
    tbody.append(tr);
  }
  dom.table.append(thead, tbody);
}

function renderChart() {
  const a = clips[0]?.ready ? clips[0] : null;
  const b = clips[1]?.ready ? clips[1] : null;
  if (!a) { chart.setData(null); return; }
  const metric = METRICS.find((m) => m.id === state.metric);
  const shift = offset();

  const series = [{ id: 'a', points: a.frames.map((f, i) => [f.t, a.series[metric.id][i]]) }];
  if (b) series.push({ id: 'b', points: b.frames.map((f, i) => [f.t - shift, b.series[metric.id][i]]) });

  const impact = a.timeOf('impact'), trophy = a.timeOf('trophy');
  const zoomed = state.zoom === 'serve' && impact != null;
  const domain = zoomed
    ? [Math.max(0, impact - ZOOM_BEFORE), Math.min(a.dur, impact + ZOOM_AFTER)]
    : [0, a.dur];
  const markers = [];
  if (trophy != null) markers.push({ t: trophy, label: 'トロフィー', side: 'left' });
  if (impact != null) markers.push({ t: impact, label: 'インパクト', side: 'right' });

  chart.setData({
    domain,
    series,
    markers,
    minSpan: metric.unit === '°' ? 20 : 0.2,
    format: (v) => `${v.toFixed(metric.digits ? 1 : 0)}${metric.unit}`,
  });
  dom.chart.setAttribute('aria-label', `${metric.label}の時間変化${b ? '（A と B）' : ''}`);

  for (const node of $$('button', dom.zoom)) {
    const on = node.dataset.zoom === (zoomed ? 'serve' : 'all');
    node.setAttribute('aria-pressed', String(on));
    if (node.dataset.zoom === 'serve') node.disabled = impact == null;
  }
  $('.key-b', dom.legend).hidden = !b;
}

// 再生位置に合わせて毎コマ書き換えるもの
function updateLive() {
  const a = clips[0];
  const b = clips[1]?.ready ? clips[1] : null;
  const t = a.video.currentTime;
  dom.seek.value = String(t);
  dom.time.textContent = `${t.toFixed(2)} / ${a.dur.toFixed(2)} 秒`;

  for (const cell of liveCells) {
    const text = cell.text(cell.metric);
    if (cell.td.textContent !== text) cell.td.textContent = text;
  }

  const metric = METRICS.find((m) => m.id === state.metric);
  const va = valueAt(a.frames, a.series[metric.id], a.shownT);
  const vb = b ? valueAt(b.frames, b.series[metric.id], b.shownT) : null;
  chart.setCursor(a.shownT, { a: va, b: vb });
  $('.val-a', dom.legend).textContent = formatValue(metric, va);
  $('.val-b', dom.legend).textContent = formatValue(metric, vb);
  $('.at', dom.legend).textContent = `${a.shownT.toFixed(2)} 秒`;

  // いまトロフィーポーズ／インパクトの位置にいるなら、そのボタンを押された見た目にする
  const half = frameStep(a.frames) / 2 + EPS;
  for (const [node, key] of [[dom.jumpTrophy, 'trophy'], [dom.jumpImpact, 'impact']]) {
    const tk = a.timeOf(key);
    const parked = !state.playing && tk != null && Math.abs(a.shownT - tk) <= half;
    node.setAttribute('aria-pressed', String(parked));
  }
}

function tick() {
  requestAnimationFrame(tick);
  const a = clips[0];
  if (!a) return;
  if (state.playing) syncB();
  let redrawn = false;
  for (const c of clips) {
    if (!c || c.analyzing || !c.dirty) continue; // 解析中は解析側が描く
    c.draw(c.shownT);
    c.dirty = false;
    redrawn = true;
  }
  if (a.ready && (redrawn || a.video.currentTime !== lastSeekTime)) {
    lastSeekTime = a.video.currentTime;
    updateLive();
  }
}

// ---------------------------------------------------------------- 操作の受け付け

const chart = new LineChart(dom.chart, {
  onScrub: (t) => { if (state.busy) return; pause(); seekTo(t); },
});

for (const metric of METRICS) {
  const option = document.createElement('option');
  option.value = metric.id;
  option.textContent = metric.label;
  dom.metric.append(option);
}
dom.metric.value = state.metric;

for (const rate of RATES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.rate = String(rate);
  b.dataset.ctl = '';
  b.textContent = `${rate}×`;
  dom.rates.append(b);
}

dom.pick.addEventListener('click', () => pickFile(0));
dom.add.addEventListener('click', () => pickFile(1));
dom.file.addEventListener('change', () => loadFile(pendingSlot, dom.file.files?.[0]));

dom.hand.addEventListener('click', (e) => {
  const hand = e.target.closest('button')?.dataset.hand;
  if (!hand || hand === state.hand || state.busy) return;
  state.hand = hand;
  writePref('hand', hand);
  for (const c of clips) if (c?.ready) c.recompute();
  render();
});

dom.view.addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (!view || view === state.view) return;
  state.view = view;
  writePref('view', view);
  render();
});

dom.play.addEventListener('click', togglePlay);
dom.prev.addEventListener('click', () => step(-1));
dom.next.addEventListener('click', () => step(1));
dom.jumpTrophy.addEventListener('click', () => jump('trophy'));
dom.jumpImpact.addEventListener('click', () => jump('impact'));
dom.seek.addEventListener('input', () => { pause(); seekTo(Number(dom.seek.value)); });

dom.rates.addEventListener('click', (e) => {
  const rate = Number(e.target.closest('button')?.dataset.rate);
  if (!rate) return;
  state.rate = rate;
  for (const c of clips) if (c?.ready) c.video.playbackRate = rate;
  renderTransport();
});

dom.showPose.addEventListener('change', () => {
  state.showPose = dom.showPose.checked;
  for (const c of clips) if (c) c.dirty = true;
});

dom.coachSlot.addEventListener('click', (e) => {
  const slot = e.target.closest('button')?.dataset.slot;
  if (slot == null) return;
  state.coachSlot = Number(slot);
  renderCoach();
});

dom.coachList.addEventListener('click', (e) => {
  const key = e.target.closest('[data-jump]')?.dataset.jump;
  if (!key || state.busy) return;
  jump(key);
  clips[0]?.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

dom.metric.addEventListener('change', () => {
  state.metric = dom.metric.value;
  renderChart();
  lastSeekTime = -1;
});

dom.zoom.addEventListener('click', (e) => {
  const zoom = e.target.closest('button')?.dataset.zoom;
  if (!zoom) return;
  state.zoom = zoom;
  renderChart();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea, button, summary')) return;
  if (!clips[0]?.ready || state.busy) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

window.addEventListener('resize', () => { for (const c of clips) if (c) c.dirty = true; });

// プロの参考値は、読めたら表示に足す（読めなくてもアプリは動く）
fetch('data/pro-reference.json')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => { proReference = data; renderCoach(); })
  .catch(() => {});

render();
requestAnimationFrame(tick);
