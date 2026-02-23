# 開発進捗メモ

最終更新: 2026-02-24

## 現在の状態

**ブランチ**: `hems`
**Docker イメージ**: `localcraw-hems:dev` (ビルド済み、104.8秒)
**次のアクション**: Claude Code を `newgrp docker` したターミナルから再起動し、動作確認を継続

---

## 完了済み作業

### git 構成
```
main   汎用 localcraw (変更不要)
hems   HEMS 特化バリアント (開発中)
```

### コミット履歴 (hems ブランチ)
```
12eb50f fix(hems): resolve all openclaw-bridge compatibility gaps
077eaf3 docs(hems): add migration guide from openclaw-bridge
368e3cc feat(hems): add Dockerfile and docker-compose override
f967ce3 feat(hems): HEMS-specialized variant
099d93b chore: add .gitignore, exclude node_modules
f175683 feat: initial localcraw implementation
```

### 実装済みファイル (hems ブランチ追加分)

| ファイル | 内容 |
|---|---|
| `src/hems/config.ts` | HEMS 設定 + Docker 環境変数読み込み + `HEMS_BROWSER_CHECKERS` パース |
| `src/hems/metrics.ts` | systeminformation による PC メトリクス (`freq_mhz`, `temp_c` 含む) |
| `src/hems/mqtt.ts` | MQTT publisher (閾値イベント含む) |
| `src/hems/server.ts` | openclaw-bridge 互換 HTTP API (Playwright ブラウザエンドポイント実装済み) |
| `src/hems/service.ts` | サービスオーケストレータ |
| `src/hems/services.ts` | Gmail / GitHub / ブラウザチェッカー |
| `src/hems/browser.ts` | Playwright/Chromium ブラウザマネージャー |
| `src/tools/hems/pc.ts` | `get_pc_status` / `get_pc_processes` エージェントツール |
| `src/tools/hems/mqtt.ts` | `mqtt_publish` / `mqtt_subscribe` エージェントツール |
| `src/tools/hems/ha.ts` | Home Assistant エージェントツール |
| `Dockerfile` | node:23-slim + Playwright Chromium |
| `docker-compose.hems.yml` | HEMS スタック compose override |
| `docs/migration-from-openclaw-bridge.md` | openclaw-bridge → localcraw-hems 移行ガイド |
| `AGENTS.md` | HEMS 特化システムプロンプト (日本語) |
| `skills/SKILL.md` | HEMS 特化スキル定義 |

---

## 動作確認状況

| 確認項目 | 状態 | 備考 |
|---|---|---|
| `npx tsc --noEmit` | ✅ 通過 | 型エラーなし |
| `docker build` | ✅ 成功 | 104.8秒, Playwright Chromium 込み |
| CLI ヘルプ表示 | ⏳ 未確認 | docker グループ再起動後に実施 |
| PC メトリクス取得 (`hems status`) | ⏳ 未確認 | `--pid=host` で実施予定 |
| HTTP API ヘルスチェック | ⏳ 未確認 | ポート 18013 でテスト予定 |
| MQTT 接続 | ⏳ 未確認 | HEMS スタック起動後に実施 |

---

## 再起動後に実施する確認コマンド

```bash
# 1. CLI ヘルプ
docker run --rm localcraw-hems:dev node_modules/.bin/tsx src/cli.ts --help

# 2. hems サブコマンド
docker run --rm localcraw-hems:dev node_modules/.bin/tsx src/cli.ts hems --help

# 3. PC メトリクス取得
docker run --rm --pid=host \
  -v /proc:/proc:ro -v /sys:/sys:ro \
  localcraw-hems:dev \
  node_modules/.bin/tsx src/cli.ts hems status

# 4. HTTP API サーバー + ヘルスチェック
docker run --rm -d --name hems-test -p 18013:8000 \
  --pid=host -v /proc:/proc:ro -v /sys:/sys:ro \
  localcraw-hems:dev
sleep 5
curl -s http://localhost:18013/health | python3 -m json.tool
curl -s http://localhost:18013/api/pc/status | python3 -m json.tool
docker stop hems-test
```

---

## openclaw-bridge との互換性 (最終状態)

全項目が互換済み:

| 非互換項目 | 修正内容 |
|---|---|
| `cpu.freq_mhz = 0` | `si.cpuCurrentSpeed()` 追加、MQTT ペイロードに含める |
| `cpu.temp_c` が温度トピックのみ | `getCpuMetrics()` に直接含める |
| `control_browser` → 501 | Playwright で実装 |
| `HEMS_BROWSER_CHECKERS` 未対応 | `HemsBrowser.runChecker()` で実装 |
