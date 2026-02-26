# localcraw

> Minimal local LLM agent framework with tool use, memory, and HEMS integration.

## 概要

localcraw は、ローカル LLM（Ollama, vLLM）や OpenAI 互換 API と連携するミニマルなエージェントフレームワークです。

- **ツール呼び出し** — ネイティブ function calling と ReAct XML フォールバックの自動切り替え
- **メモリ** — SQLite ベースのハイブリッド検索（BM25 + コサイン類似度）
- **スキル** — Markdown ファイルからスキルをロードし、キーワードマッチでシステムプロンプトに注入
- **Docker サンドボックス** — シェルコマンドをコンテナ内で安全に実行
- **HEMS バリアント** — PC メトリクス監視、MQTT パブリッシュ、Home Assistant 連携、サービスチェッカー（Gmail, GitHub, ブラウザ）を統合した IoT/スマートホーム向け構成

## 必要環境

| ソフトウェア | バージョン | 備考 |
|---|---|---|
| Node.js | 23+ | `node:sqlite` を使用 |
| npm | 10+ | |
| Ollama | 最新 | オプション（ローカル LLM 使用時） |
| Docker | 24+ | オプション（シェルサンドボックス / HEMS 使用時） |

## インストール

```bash
git clone https://github.com/4beshinji/localcraw.git
cd localcraw
npm install
```

## 使い方

### 基本

```bash
# インタラクティブチャット
npx tsx src/cli.ts chat

# ワンショットメッセージ
npx tsx src/cli.ts chat -m "Hello"

# 設定確認
npx tsx src/cli.ts config

# メモリ検索
npx tsx src/cli.ts memory search <query>
```

### HEMS バリアント

```bash
# HEMS ツール付きチャット
npx tsx src/cli.ts chat --hems

# openclaw-bridge 互換サーバー起動
npx tsx src/cli.ts hems serve

# PC メトリクススナップショット
npx tsx src/cli.ts hems status
```

### Docker (HEMS)

```bash
docker build -t localcraw-hems:dev .
docker compose -f docker-compose.hems.yml up
```

## 設定

### 基本設定 (`~/.localcraw/config.json`)

JSON5 形式。未指定のフィールドにはデフォルト値が適用されます。

| セクション | キー | デフォルト | 説明 |
|---|---|---|---|
| `provider` | `type` | `"ollama"` | `"ollama"` / `"vllm"` / `"openai"` |
| | `baseUrl` | `"http://localhost:11434"` | LLM エンドポイント |
| | `model` | `"qwen2.5:14b"` | 使用モデル |
| | `embedModel` | `"nomic-embed-text"` | 埋め込みモデル |
| | `contextSize` | `8192` | コンテキストウィンドウサイズ |
| | `apiKey` | — | API キー（OpenAI 使用時） |
| `toolCalling` | `mode` | `"auto"` | `"native"` / `"react"` / `"auto"` |
| | `retries` | `3` | ツール呼び出しリトライ回数 (0–10) |
| `docker` | `enabled` | `true` | サンドボックス有効化 |
| | `image` | `"ubuntu:22.04"` | Docker イメージ |
| | `memoryLimit` | `"512m"` | メモリ制限 |
| | `timeoutSec` | `30` | タイムアウト（秒） |
| `memory` | `dbPath` | `"~/.localcraw/memory.sqlite"` | SQLite パス |
| | `maxResults` | `5` | 検索結果上限 |
| | `similarityThreshold` | `0.7` | 類似度閾値 (0–1) |
| `context` | `maxTokens` | `6000` | コンテキスト最大トークン |
| | `compressionThreshold` | `0.75` | 圧縮開始閾値 (0–1) |

### HEMS 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `MQTT_BROKER` | `localhost` | MQTT ブローカーホスト |
| `MQTT_USER` | `hems` | MQTT ユーザー |
| `MQTT_PASS` | `hems_dev_mqtt` | MQTT パスワード |
| `HEMS_GMAIL_ENABLED` | `false` | Gmail チェッカー有効化 |
| `HEMS_GMAIL_EMAIL` | — | Gmail アドレス |
| `HEMS_GMAIL_APP_PASSWORD` | — | Gmail アプリパスワード |
| `HEMS_GMAIL_INTERVAL` | `300` | Gmail チェック間隔（秒） |
| `HEMS_GITHUB_ENABLED` | `false` | GitHub チェッカー有効化 |
| `HEMS_GITHUB_TOKEN` | — | GitHub トークン |
| `HEMS_GITHUB_INTERVAL` | `300` | GitHub チェック間隔（秒） |
| `HEMS_BROWSER_CHECKERS` | `[]` | ブラウザチェッカー（JSON 配列） |
| `HEMS_HA_URL` | — | Home Assistant URL |
| `HEMS_HA_TOKEN` | — | Home Assistant トークン |
| `PORT` | `8000` | HTTP サーバーポート |

## アーキテクチャ

```
src/
├── cli.ts                # エントリポイント (Commander.js)
├── agent/
│   ├── runner.ts         # エージェントループ (最大10イテレーション)
│   ├── context.ts        # システムプロンプト組み立て・コンテキスト圧縮
│   └── session.ts        # JSONL セッションログ
├── llm/
│   ├── client.ts         # OpenAI 互換クライアント (ストリーミング)
│   ├── toolcall.ts       # ReAct XML フォールバック
│   └── compress.ts       # トークン推定・要約圧縮
├── memory/
│   ├── store.ts          # SQLite (node:sqlite) ハイブリッド検索
│   └── embed.ts          # 埋め込みベクトル生成
├── tools/
│   ├── registry.ts       # Tool インターフェース・レジストリ
│   ├── filesystem.ts     # ファイル操作
│   ├── shell.ts          # Docker サンドボックス
│   ├── web.ts            # Web フェッチ
│   └── hems/             # HEMS 専用ツール (pc, mqtt, ha)
├── skills/
│   └── loader.ts         # スキルファイル読み込み・注入
└── hems/
    ├── config.ts          # HEMS 設定 (env overlay)
    ├── service.ts         # HemsService オーケストレーター
    ├── metrics.ts         # PC メトリクス (systeminformation)
    ├── server.ts          # HTTP API (openclaw-bridge 互換)
    ├── services.ts        # サービスチェッカー (Gmail, GitHub, ブラウザ)
    └── browser.ts         # Playwright/Chromium マネージャー
```

詳細なアーキテクチャは [CLAUDE.md](./CLAUDE.md) を参照してください。

## ドキュメント

- [CLAUDE.md](./CLAUDE.md) — アーキテクチャ詳細・開発コマンド
- [docs/migration-from-openclaw-bridge.md](./docs/migration-from-openclaw-bridge.md) — openclaw-bridge からの移行ガイド
- [docs/dev-progress.md](./docs/dev-progress.md) — 開発進捗メモ

## ライセンス

[MIT](./LICENSE)
