// 入口のパスワードの設定。このファイルは tools/set-password.mjs が書き換える（手で編集しない）。
// 入っているのはパスワードそのものではなく、そこから計算した照合用の値。
// hash が空なら、パスワードなしで誰でも開ける。
export const PASSWORD = {
  salt: '34e9aa83d0da73fc03d8f29ddac7e60c',
  hash: '9712466977949d9124edd90804e4c400dca19388ad997d3dff10c19a417facde',
  iterations: 200000,
};
