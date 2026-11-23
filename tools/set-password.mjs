// 入口のパスワードを設定する。パスワードそのものは保存せず、照合用の値だけを docs/js/config.js に書く。
//
// 使い方（tennis-form フォルダの外からでも可）:
//   node tennis-form/tools/set-password.mjs           … パスワードを聞かれるので入力する
//   node tennis-form/tools/set-password.mjs --clear   … パスワードなしに戻す
//
// 書き換えたあと、docs/js/config.js を公開（commit・push）すると反映される。

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ITERATIONS = 200000;
const MIN_LENGTH = 6;
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'js', 'config.js');

/** 照合用の値（docs/js/gate.js の derive と同じ計算） */
export function deriveSync(password, salt, iterations) {
  return pbkdf2Sync(Buffer.from(password.normalize('NFC'), 'utf8'), Buffer.from(salt, 'utf8'), iterations, 32, 'sha256').toString('hex');
}

/** config.js の中身を作る。password が空ならパスワードなし */
export function configSource(password, salt = randomBytes(16).toString('hex')) {
  const hash = password ? deriveSync(password, salt, ITERATIONS) : '';
  return `// 入口のパスワードの設定。このファイルは tools/set-password.mjs が書き換える（手で編集しない）。
// 入っているのはパスワードそのものではなく、そこから計算した照合用の値。
// hash が空なら、パスワードなしで誰でも開ける。
export const PASSWORD = {
  salt: '${password ? salt : ''}',
  hash: '${hash}',
  iterations: ${ITERATIONS},
};
`;
}

let pipedLines = null;

// 入力した文字を画面に出さずに 1 行読む
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) { // パイプなどから渡された場合は、全部読んでから 1 行ずつ渡す
      pipedLines ??= new Promise((done) => {
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk) => { data += chunk; });
        stdin.on('end', () => done(data.split(/\r?\n/)));
      });
      pipedLines.then((lines) => { stdout.write('\n'); resolve(lines.shift() ?? ''); });
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); reject(new Error('中止しました')); return; }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } continue; }
        value += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  if (process.argv.includes('--clear')) {
    await writeFile(CONFIG_PATH, configSource(''));
    console.log('パスワードなしに戻しました。');
    return;
  }
  const first = (await ask(`新しいパスワード（${MIN_LENGTH} 文字以上）: `)).trim();
  if (first.length < MIN_LENGTH) { console.error(`${MIN_LENGTH} 文字以上にしてください。何も変更していません。`); process.exit(1); }
  const second = (await ask('もう一度: ')).trim();
  if (first !== second) { console.error('2 回の入力が違います。何も変更していません。'); process.exit(1); }
  await writeFile(CONFIG_PATH, configSource(first));
  console.log('設定しました（保存したのは照合用の値だけで、パスワードそのものは保存していません）。');
  console.log('公開版に反映するには、Claude に「パスワードを設定した」と伝えてください。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
