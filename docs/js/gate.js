// 入口のパスワード画面。
// 公開されている静的なページなので本当の鍵にはならない（中身のファイルは誰でも取得できる）。
// URL を知っただけの人が、そのまま使えないようにするためのもの。

import { PASSWORD } from './config.js';

const STORE_KEY = 'tennis-form:pass';

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * パスワードから照合用の値を計算する（PBKDF2-HMAC-SHA256、32 バイト、16 進文字列）。
 * わざと時間のかかる計算にして、総当たりを遅くする。tools/set-password.mjs と同じ計算。
 */
export async function derive(password, salt, iterations) {
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', text.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: text.encode(salt), iterations },
    key,
    256,
  );
  return toHex(bits);
}

function remembered() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}
function remember(hash) {
  try { localStorage.setItem(STORE_KEY, hash); } catch { /* 覚えられなくても、その場では入れる */ }
}

function open(gate) {
  gate.hidden = true;
  document.body.classList.remove('locked');
}

function init() {
  const gate = document.getElementById('gate');
  if (!gate) return;
  // パスワード未設定、またはこの端末で一度通っている（パスワードを変えると hash が変わり、聞き直す）
  if (!PASSWORD.hash || remembered() === PASSWORD.hash) { open(gate); return; }

  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-pass');
  const button = document.getElementById('gate-submit');
  const error = document.getElementById('gate-error');
  document.getElementById('gate-loading').hidden = true;
  form.hidden = false;
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    button.disabled = true;
    button.textContent = '確認中…';
    error.hidden = true;
    let ok = false;
    try {
      ok = (await derive(value, PASSWORD.salt, PASSWORD.iterations)) === PASSWORD.hash;
    } catch (err) {
      console.error(err);
    }
    button.disabled = false;
    button.textContent = '入る';
    if (ok) {
      remember(PASSWORD.hash);
      open(gate);
    } else {
      error.hidden = false;
      input.select();
    }
  });
}

if (typeof document !== 'undefined') init();
