"""プロのサーブ公開データの付属情報（metadata.parquet）を、集計スクリプト用の JSON にする。

使い方:
    python -I tools/parquet_to_json.py <metadata.parquet> <metadata.json>
    python -I tools/parquet_to_json.py <metadata.parquet> --columns   # 列名と先頭 3 行を見るだけ

出力は 1 本 1 行で { "stem": 骨格ファイルの名前（拡張子なし）, "group": "men" | "women", "player": 選手を区別する文字列,
"quality": 品質ラベル（3 = 追跡の乱れなし、1 = 乱れが大きい、不明は 0） }。
選手名は「同じ選手のサーブをまとめる」ためだけに使い、アプリには載せない。
"""
import json
import sys

import pandas as pd

# 列名は公開ページの説明と実物で食い違いがあるので、候補を順に試す
STEM_COLUMNS = ["serve_id", "keypoint_file", "file", "filename", "id"]
GENDER_COLUMNS = ["server_gender", "gender"]
PLAYER_COLUMNS = ["server", "server_name", "player"]
QUALITY_COLUMNS = ["quality_label", "keypoint_quality"]


def pick(frame, candidates, what):
    for name in candidates:
        if name in frame.columns:
            return name
    raise SystemExit(f"{what} の列が見つかりません。列名: {list(frame.columns)}")


def main():
    src = sys.argv[1]
    frame = pd.read_parquet(src)
    if len(sys.argv) > 2 and sys.argv[2] == "--columns":
        print("行数:", len(frame))
        print("列名:", list(frame.columns))
        print(frame.head(3).to_string())
        return

    dst = sys.argv[2]
    stem_col = pick(frame, STEM_COLUMNS, "骨格ファイル名")
    gender_col = pick(frame, GENDER_COLUMNS, "性別")
    player_col = pick(frame, PLAYER_COLUMNS, "選手")
    quality_col = next((c for c in QUALITY_COLUMNS if c in frame.columns), None)
    rows = []
    for _, row in frame.iterrows():
        gender = str(row[gender_col]).strip().upper()[:1]
        if gender not in ("M", "F"):
            continue
        stem = str(row[stem_col])
        if stem.endswith(".npy"):
            stem = stem[:-4]
        quality = row[quality_col] if quality_col else 3
        rows.append({
            "stem": stem,
            "group": "men" if gender == "M" else "women",
            "player": str(row[player_col]),
            "quality": 0 if pd.isna(quality) else float(quality),
        })
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print("書き出した行数:", len(rows), "/", len(frame))


if __name__ == "__main__":
    main()
