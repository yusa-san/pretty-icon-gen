# Pretty Icon Gen

商用利用・改変・再配布OKのフリーSVGアイコンを組み合わせて、欲しい形の新しいアイコンを作ってダウンロードできるツールです。
GitHub Pages でそのまま公開できる静的サイト（ビルド不要・サーバー不要）です。

## できること

- **単語で検索**: 「家」「メール」「セキュリティ」「shield」など日本語・英語でアイコンを検索（8,000+個）
- **組み合わせ（コラージュ）**: 検索結果をクリック／ドラッグでキャンバスに追加し、移動・拡大縮小・回転・反転・色・線の太さを調整
  - 2個目以降のアイコンは自動で右下の「バッジ」として配置
  - 「くり抜き縁（ハロー）」で重なったパーツを見やすく
  - 背景図形（円・角丸・スクワクル・六角形・盾・吹き出し…）、グラデーション、図形・テキストレイヤー
  - 元に戻す／やり直し、キーボード操作（矢印・Delete・Ctrl+D）
- **ダウンロード**: SVG / PNG（16〜1024px）/ SVGコードのコピー / 再編集用JSON
- **ギャラリー**: 作品をブラウザに保存、まとめてZIP（SVG+PNG+JSON+ライセンス表記）
- **スマホ対応**: 画面上部にキャンバスを固定し、下のタブ（素材／調整／レイヤー／書き出し／AI）で操作を切り替え。タップで追加・ドラッグで移動、2本指ピンチで拡大縮小・回転
- **生成AIアシスト（任意）**: APIキーを入れると
  - エディタで「雲に鍵のバッジ」のように頼んで新規作成、または今のアイコンを言葉で修正
  - **AI一括発注**: 1行1アイコンで複数まとめて発注。共通スタイル（背景形状・メインカラー・線の太さ）を揃えて生成し、ZIPで一括ダウンロード
  - 対応: Anthropic (Claude) / OpenAI / Google Gemini

AIは「キーワード抽出 → ローカルのアイコン検索 → 候補から構成をJSONで設計」という流れで動きます。AIが描くのではなく、ライセンスの明確な既存アイコンを組み合わせるので、出力は常にきれいなSVGになります。

## 収録アイコンとライセンス

| セット | 数 | ライセンス |
| --- | --- | --- |
| [Lucide](https://lucide.dev) | 約2,000 | ISC |
| [Tabler Icons](https://tabler.io/icons)（線） | 約5,200 | MIT |
| Tabler Icons（塗り） | 約1,000 | MIT |

いずれも商用利用・改変・再配布が可能です。MIT / ISC は配布時に著作権表示とライセンス文を含めることを条件としているため、作ったアイコンを配布・同梱する場合は ZIP に入っている `CREDITS.txt`（または [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)）を添えてください。

## APIキーの扱い

- キーはブラウザから各社のAPIへ**直接**送信されます。このサイト（GitHub Pages）側には一切送られません。
- 既定ではタブを閉じると消えます（sessionStorage）。「このブラウザに保存する」をオンにした場合のみ localStorage に保存されます。
- 利用料金はご自身のAPIアカウントに課金されます。
- Anthropic はブラウザ直接呼び出しのため `anthropic-dangerous-direct-browser-access` ヘッダーを使っています。公開サイトにキーを埋め込むのではなく、各ユーザーが自分のキーを入れる前提の設計です。

## GitHub Pages で公開する

### 方法A: GitHub Actions（同梱のワークフロー）

1. このリポジトリを `main` ブランチにマージ
2. GitHub の **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に変更
3. `main` に push するたびに `.github/workflows/pages.yml` が自動デプロイします
   → `https://<ユーザー名>.github.io/pretty-icon-gen/`

### 方法B: ブランチから直接

**Settings → Pages → Source: Deploy from a branch**、Branch: `main` / `/(root)` を選ぶだけでも動きます（ビルド不要）。

## ローカルで動かす

ES Modules と `fetch` を使うので、ファイルを直接開くのではなく簡易サーバー経由で開いてください。

```sh
python3 -m http.server 8080
# または
npm run serve
```

## アイコンデータの更新

```sh
npm install          # lucide-static / @tabler/icons を取得
npm run build:icons  # data/icons.json を再生成
```

バージョンは `package.json` で固定しています。他のアイコンセットを追加する場合は `scripts/build-icons.mjs` に追記してください（**商用利用・改変・再配布が可能なライセンスのもの**に限ります）。

## 構成

```
index.html              画面
css/style.css           スタイル（ダークモード対応）
js/app.js               UI・エディタ・ギャラリー・一括発注
js/compose.js           合成アイコンのデータモデルとSVG描画
js/icons.js             アイコン読み込み・検索
js/ja-dict.js           日本語→英語タグの検索辞書（自由に追加可）
js/ai.js                生成AI呼び出し（Anthropic / OpenAI / Gemini）
data/icons.json         アイコンデータ（ビルド生成物）
vendor/jszip.min.js     ZIP作成ライブラリ（MIT）
scripts/build-icons.mjs アイコンデータ生成スクリプト
```

## ライセンス

収録アイコン・ライブラリのライセンスは [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) を参照してください。
