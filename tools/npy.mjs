// NumPy の .npy ファイル（数値の配列）を読む。
// 数値型（float32 / float64、リトルエンディアン、C 順）だけを受け付け、
// オブジェクト配列（中に任意のデータを持てる形式）は読まずにエラーにする。

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"

/**
 * @param {Uint8Array} bytes ファイルの中身
 * @returns {{ shape: number[], data: Float32Array | Float64Array }}
 */
export function parseNpy(bytes) {
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('npy ファイルではありません');
  }
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerLength, headerStart;
  if (major === 1) { headerLength = view.getUint16(8, true); headerStart = 10; }
  else if (major === 2 || major === 3) { headerLength = view.getUint32(8, true); headerStart = 12; }
  else throw new Error(`未対応の npy バージョンです: ${major}`);

  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLength));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeText == null) throw new Error(`npy のヘッダーを読めません: ${header}`);
  if (fortran !== 'False') throw new Error('Fortran 順の配列には対応していません');

  const shape = shapeText.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const offset = headerStart + headerLength;
  const size = descr === '<f4' ? 4 : descr === '<f8' ? 8 : 0;
  if (!size) throw new Error(`未対応のデータ型です: ${descr}`);
  if (offset + count * size > bytes.byteLength) throw new Error('npy のデータが途中で切れています');

  // データ部分を新しい領域にコピーしてから型付き配列にする。
  // ファイル内の位置は 4/8 バイト境界に揃っていないことがあり、Node の Buffer は slice() しても
  // 元の大きな領域を共有したままなので、new Uint8Array(...) で確実に複製する。
  const copy = new Uint8Array(bytes.subarray(offset, offset + count * size));
  const data = size === 4 ? new Float32Array(copy.buffer) : new Float64Array(copy.buffer);
  return { shape, data };
}

/** テスト用：数値の配列を .npy のバイト列にする（float32 か float64） */
export function encodeNpy(shape, values, descr = '<f4') {
  const size = descr === '<f4' ? 4 : 8;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += ' '.repeat(pad === 64 ? 0 : pad) + '\n';
  const out = new Uint8Array(10 + header.length + values.length * size);
  out.set(MAGIC, 0);
  out[6] = 1; out[7] = 0;
  const view = new DataView(out.buffer);
  view.setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
  const base = 10 + header.length;
  values.forEach((v, i) => {
    if (size === 4) view.setFloat32(base + i * 4, v, true); else view.setFloat64(base + i * 8, v, true);
  });
  return out;
}
