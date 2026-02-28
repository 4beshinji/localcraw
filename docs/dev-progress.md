# 開発進捗メモ

最終更新: 2026-02-28

## 現在の状態

**ブランチ**: `hems`
**Docker イメージ**: `localcraw-hems:dev` (ビルド済み、動作確認済み)
**次のアクション**: Discord/Slack Bot 実環境テスト

---

## 完了済み作業

### Phase 1: コア実装

- CLI チャット (インタラクティブ / ワンショット)
- AgentRunner (ネイティブ tool calling + ReAct フォールバック)
- MemoryStore (SQLite BM25 + 埋め込みコサイン類似度)
- Docker サンドボックス (シェルツール)
- スキルローダー (Markdown → システムプロンプト注入)

### Phase 2: HEMS バリアント

- PC メトリクス (`systeminformation`) + MQTT パブリッシュ
- openclaw-bridge 互換 HTTP API
- サービスチェッカー (Gmail IMAP, GitHub Octokit, Playwright ブラウザ)
- Home Assistant REST API ツール
- Docker 構成 (`Dockerfile`, `docker-compose.hems.yml`)

### Phase 3: チャットBot アダプタ

- `src/bots/setup.ts` — 共通ブートストラップ (`BotContext`, `createRunner`)
- `src/bots/discord.ts` — Discord Bot (slash command + mention reply)
- `src/bots/slack.ts` — Slack Bot (Socket Mode, app_mention + DM)
- `src/config/index.ts` — discord/slack スキーマ追加 + 環境変数オーバーレイ
- `src/cli.ts` — `bot discord` / `bot slack` サブコマンド (動的 import)

---

## 動作確認状況

| 確認項目 | 状態 | 備考 |
|---|---|---|
| `npx tsc --noEmit` | ✅ 通過 | 型エラーなし |
| `docker build` | ✅ 成功 | Playwright Chromium 込み |
| CLI チャット | ✅ 確認済み | インタラクティブ / ワンショット |
| PC メトリクス取得 (`hems status`) | ✅ 確認済み | `--pid=host` で CPU/メモリ/温度/プロセス取得 |
| HTTP API (`/health`, `/api/pc/status`) | ✅ 確認済み | 正常応答 |
| MQTT 接続 | ✅ 確認済み | `hems/#` トピックに定期パブリッシュ |
| Discord Bot | ⬜ 未テスト | 型チェック通過済み |
| Slack Bot | ⬜ 未テスト | 型チェック通過済み |

---

## openclaw-bridge との互換性

全項目が互換済み。詳細は [migration-from-openclaw-bridge.md](./migration-from-openclaw-bridge.md) を参照。
