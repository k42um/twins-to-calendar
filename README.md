# TWINS to Calendar

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-blue?logo=googlechrome)](https://chromewebstore.google.com/detail/aenjjegbenejholjhhidcpfgmfbmkfko?utm_source=item-share-cb)

筑波大学の履修登録システム TWINS から授業の時間割を取得し、Google カレンダー・Apple カレンダー・Outlook などへインポートできる ICS ファイルを生成する Chrome 拡張機能です。

> [!WARNING]
> このツールが生成するカレンダーデータ（ターム期間・祝日・振替日など）の正確性は保証しません。実際の時間割・休講・振替については必ず TWINS や大学の公式情報を確認してください。本ツールの利用によって生じたいかなる不利益についても、作者は責任を負いません。


## インストール（デベロッパーモード）

Chrome 拡張機能ストアには公開されていないため、デベロッパーモードで手動インストールします。

1. このリポジトリを ZIP でダウンロード、または `git clone` する
   - `Code` → `Download ZIP` → 任意のフォルダに解凍
2. Chrome で `chrome://extensions` を開く
3. 右上の **「デベロッパー モード」** をオンにする
4. **「パッケージ化されていない拡張機能を読み込む」** をクリック
5. リポジトリのフォルダ（`manifest.json` があるフォルダ）を選択する

ツールバーにカレンダーアイコンが表示されれば完了です。


## 基本的な使い方

1. TWINS にログインし、**「履修登録・登録状況照会」** ページを開く
2. 確認したいタームのタブを選択する（例: 春A）
3. Chrome ツールバーの拡張機能アイコンをクリックする
4. 登録科目の一覧が表示されるので、必要に応じてチェックを外して絞り込む
5. **「ICS をダウンロード」** ボタンをクリックしてファイルを保存する
6. ダウンロードした `.ics` ファイルを各カレンダーアプリにインポートする

### カレンダーへのインポート方法

| サービス | 手順 |
|----------|------|
| **Google カレンダー** | [calendar.google.com](https://calendar.google.com) → 設定（⚙️）→「インポート」→ ファイルを選択 |
| **Apple カレンダー（Mac）** | `.ics` ファイルをダブルクリック、またはカレンダー.app にドラッグ |
| **Microsoft Outlook** | [outlook.live.com](https://outlook.live.com) → カレンダー →「カレンダーの追加」→「ファイルから」 |


## 教室情報の取り込み

教室・授業形態の情報は TWINS からダウンロードできる xlsx ファイルから取り込みます。

1. TWINS にログインし、**「ダウンロード」→「ClassroomInfo」** から xlsx ファイルをダウンロードする
   - ファイル名は `kdb_2026--ja.xlsx` のように年度によって異なる
2. 拡張機能アイコンの上部バー「教室データ未取り込み → 取り込む」をクリック、または Chrome の拡張機能管理画面から「オプション」を開く
3. ダウンロードした xlsx ファイルを選択して **「取り込む」** をクリックする

取り込んだデータはブラウザのローカルストレージに保存され、ICS 生成時に自動で参照されます。


## 設定ファイル（`calendars/YYYY.json`）

ターム期間・祝日・振替授業日は年度ごとに `calendars/` フォルダの JSON ファイルで管理します。新しい年度の設定を追加するには `calendars/2026.json` を参考に同じ形式で作成してください。

### 書式

```json
{
  "terms": {
    "春A": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "春B": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "春C": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "秋A": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "秋B": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "秋C": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }
  },
  "holidays": [
    "2026-04-29",
    "2026-05-03..2026-05-06"
  ],
  "substitutes": {
    "2026-04-30": "水",
    "2026-05-08": "月"
  }
}
```

### 各フィールドの説明

#### `terms`

各タームの開始日と終了日を指定します。ポップアップ上で手動変更することもでき、その値はブラウザのストレージに保存されて JSON より優先されます。

#### `holidays`

休講となる日付を列挙します。

- 単日: `"YYYY-MM-DD"`
- 連続した範囲: `"YYYY-MM-DD..YYYY-MM-DD"`（開始日と終了日を `..` でつなぐ）

#### `substitutes`

曜日振替が発生する日を記述します。キーが振替日、値がその日に実施される曜日の時間割です。

```json
"substitutes": {
  "2026-04-30": "水"
}
```

上記の例では「4月30日（木）は水曜日の時間割で授業を行う」を意味します。
