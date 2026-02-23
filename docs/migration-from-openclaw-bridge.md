# openclaw-bridge → localcraw-hems 移行ガイド

> **対象**: HEMS スタックで `--profile openclaw` を使用している環境
> **所要時間**: 約 20〜30 分
> **ダウンタイム**: コンテナ切り替えの数秒のみ

---

## 概要

| 項目 | openclaw-bridge (旧) | localcraw-hems (新) |
|---|---|---|
| 実装言語 | Python 3.11 / FastAPI | Node.js 23 / TypeScript |
| PC メトリクス取得 | OpenClaw WebSocket RPC 経由 | systeminformation ライブラリで直接取得 |
| シェルコマンド実行 | OpenClaw Gateway 経由 | 直接実行 (sanitizer 付き) |
| デスクトップ通知 | OpenClaw Gateway 経由 | notify-send / osascript で直接送信 |
| ブラウザ制御 | OpenClaw Gateway 経由 | **未実装 (501)** ← 制限あり |
| ブラウザチェッカー | HEMS_BROWSER_CHECKERS で設定可 | **未実装** ← 制限あり |
| Gmail チェッカー | ✅ | ✅ |
| GitHub チェッカー | ✅ | ✅ |
| 内部ポート | 8000 | 8000 (同じ) |
| OpenClaw Gateway 必要 | **必要** | **不要** |

---

## 機能互換性マトリクス

### brain ツール呼び出し

| ツール名 | 動作 | 備考 |
|---|---|---|
| `get_pc_status` | ✅ 互換 | MQTT 経由で WorldModel に反映される |
| `run_pc_command` | ✅ 互換 | 直接実行に変わるが戻り値形式は同じ |
| `send_pc_notification` | ✅ 互換 | notify-send / osascript にフォールバック |
| `get_service_status` | ✅ 互換 | MQTT 経由で WorldModel に反映される |
| `control_browser` | ⚠️ **非互換** | HTTP 501 を返す。brain は `{"success": false}` として処理 |

### MQTT トピック

| トピック | 互換性 | 備考 |
|---|---|---|
| `hems/pc/metrics/cpu` | ✅ | `freq_mhz` フィールドが 0 になる（brain は未使用） |
| `hems/pc/metrics/memory` | ✅ | 完全互換 |
| `hems/pc/metrics/gpu` | ✅ | GPU なし環境は publish しない（brain は 0 として扱う） |
| `hems/pc/metrics/disk` | ✅ | 完全互換 |
| `hems/pc/metrics/temperature` | ✅ | 完全互換 |
| `hems/pc/processes/top` | ✅ | 完全互換 |
| `hems/pc/bridge/status` | ✅ | 完全互換 |
| `hems/pc/events/*` | ✅ | 閾値イベントは同じトピックに発行 |
| `hems/services/{name}/status` | ✅ | Gmail・GitHub のみ |
| `hems/services/{name}/event` | ✅ | 未読数増加時のみ発行 |
| `hems/services/{browser_checker}/status` | ❌ | ブラウザチェッカー未実装のため publish なし |

### REST API エンドポイント

| エンドポイント | 互換性 | 備考 |
|---|---|---|
| `GET /health` | ✅ | レスポンスフィールドは一部異なるが brain は呼ばない |
| `GET /api/pc/status` | ✅ | brain は MQTT 経由のため実質未使用 |
| `GET /api/pc/processes` | ✅ | 完全互換 |
| `POST /api/pc/command` | ✅ | 完全互換 |
| `POST /api/pc/notify` | ✅ | 互換 (`priority` フィールドは無視される) |
| `GET /api/services/status` | ✅ | 完全互換 |
| `POST /api/pc/browser/navigate` | ❌ | 501 Not Implemented |
| `POST /api/pc/browser/eval` | ❌ | 501 Not Implemented |
| `POST /api/pc/browser/get_url` | ❌ | 501 Not Implemented |
| `POST /api/pc/browser/get_title` | ❌ | 501 Not Implemented |
| `POST /api/pc/process/kill` | ✅ | 互換 (SIGTERM を送信) |

---

## 環境変数マッピング

### 削除される変数（不要になる）

```bash
# OpenClaw Gateway への接続 — localcraw は直接実行するため不要
OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789
OPENCLAW_GATEWAY_TOKEN=
```

### 変更なしで使える変数

```bash
OPENCLAW_METRICS_INTERVAL=10        # メトリクス収集間隔 (秒)
OPENCLAW_PROCESS_INTERVAL=30        # プロセス一覧収集間隔 (秒)
MQTT_BROKER=mosquitto
MQTT_USER=hems
MQTT_PASS=hems_dev_mqtt
HEMS_GMAIL_ENABLED=true
HEMS_GMAIL_EMAIL=user@gmail.com
HEMS_GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
HEMS_GMAIL_INTERVAL=300
HEMS_GITHUB_ENABLED=true
HEMS_GITHUB_TOKEN=ghp_xxxx
HEMS_GITHUB_INTERVAL=300
HEMS_PORT_OPENCLAW_BRIDGE=8013      # ホスト側の外部ポートマッピング (変更不要)
TZ=Asia/Tokyo
```

### 廃止される変数（設定しても無視される）

```bash
HEMS_BROWSER_CHECKERS=[]            # ブラウザチェッカー未実装
```

### 新規追加される変数

```bash
# コンテナ内部リッスンポート (デフォルト: 8000、通常変更不要)
PORT=8000

# Home Assistant 直接制御 (オプション)
HEMS_HA_URL=http://homeassistant.local:8123
HEMS_HA_TOKEN=your-long-lived-access-token
```

### brain 側の変数変更

```bash
# 旧: openclaw-bridge コンテナ名を参照
OPENCLAW_BRIDGE_URL=http://openclaw-bridge:8000

# 新: localcraw-bridge コンテナ名を参照
OPENCLAW_BRIDGE_URL=http://localcraw-bridge:8000
```

---

## アーキテクチャの変化

```
【旧構成】
brain ←MQTT← openclaw-bridge ←WebSocket← OpenClaw Gateway (ホスト常駐)
brain ←HTTP→ openclaw-bridge
openclaw-bridge → PC metrics (OpenClaw RPC経由)
openclaw-bridge → shell command (OpenClaw RPC経由)

【新構成】
brain ←MQTT← localcraw-bridge  ← systeminformation (直接)
brain ←HTTP→ localcraw-bridge
localcraw-bridge → shell command (sh -c で直接実行)
```

OpenClaw Gateway (ホスト側常駐プロセス) が不要になります。

---

## 移行手順

### 前提確認

```bash
# hems ディレクトリで実行
cd /path/to/hems

# Docker が動いていることを確認
docker compose ps

# localcraw の場所を確認
ls /path/to/localcraw/Dockerfile
```

### ステップ 1: `.env` の更新

```bash
# .env をエディタで開く
nano .env   # または vim .env

# 変更する行:
# 1. brain の接続先コンテナ名を変更
OPENCLAW_BRIDGE_URL=http://localcraw-bridge:8000   # openclaw-bridge → localcraw-bridge

# 2. 不要な行を削除またはコメントアウト
# OPENCLAW_GATEWAY_URL=...   ← 削除可
# OPENCLAW_GATEWAY_TOKEN=... ← 削除可
# HEMS_BROWSER_CHECKERS=...  ← 削除可 (未実装)
```

### ステップ 2: 旧ブリッジの停止

```bash
docker compose --profile openclaw down
```

### ステップ 3: localcraw-bridge の起動

```bash
# compose override ファイルを指定して起動
docker compose \
  -f infra/docker-compose.yml \
  -f /path/to/localcraw/docker-compose.hems.yml \
  --profile localcraw up -d --build
```

> **docker-compose.hems.yml の場所**: localcraw リポジトリのルートにあります。
> パスは環境に合わせて調整してください。

### ステップ 4: brain の再起動（環境変数更新のため）

```bash
docker compose restart brain
```

### ステップ 5: 動作確認

```bash
# ブリッジの起動確認
docker logs hems-localcraw-bridge --tail=30

# ヘルスチェック確認
curl http://localhost:8013/health
# → {"status":"ok","uptime_s":...,"snapshot_available":true}

# MQTT にメトリクスが流れているか確認
docker exec hems-mqtt mosquitto_sub \
  -h localhost -u hems -P hems_dev_mqtt \
  -t 'hems/pc/#' -v -C 5

# brain のログで OpenClaw 連携が有効になっているか確認
docker logs hems-brain --tail=20 | grep -i openclaw
# → "OpenClaw integration enabled (bridge=http://localcraw-bridge:8000)"
```

---

## 検証チェックリスト

### 基本動作

- [ ] `GET http://localhost:8013/health` が `{"status":"ok"}` を返す
- [ ] `docker logs hems-localcraw-bridge` にエラーがない
- [ ] `docker logs hems-brain` に `OpenClaw integration enabled` が出る

### MQTT

- [ ] `hems/pc/metrics/cpu` に 10 秒おきにデータが届く
- [ ] `hems/pc/metrics/memory` にデータが届く
- [ ] `hems/pc/bridge/status` に `{"connected":true,...}` が届く

### brain からのツール呼び出し

```bash
# brain に直接話しかけてPCステータスを確認させる
# ダッシュボードのチャットまたは直接 LLM に問いかける:
# 「PCのCPU使用率を確認して」
```

- [ ] brain が `get_pc_status` を呼び、CPU/メモリ情報が返る
- [ ] `run_pc_command` で `ls /` が実行できる
- [ ] `send_pc_notification` でデスクトップ通知が届く（notify-send が必要）

### サービス監視（設定している場合）

```bash
docker exec hems-mqtt mosquitto_sub \
  -h localhost -u hems -P hems_dev_mqtt \
  -t 'hems/services/#' -v -C 10
```

- [ ] Gmail: `hems/services/gmail/status` にデータが届く
- [ ] GitHub: `hems/services/github/status` にデータが届く

---

## ロールバック手順

問題が発生した場合、旧構成に戻す手順:

```bash
# 1. localcraw-bridge を停止
docker compose \
  -f infra/docker-compose.yml \
  -f /path/to/localcraw/docker-compose.hems.yml \
  --profile localcraw down

# 2. .env を元に戻す
#    OPENCLAW_BRIDGE_URL=http://openclaw-bridge:8000
#    OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789

# 3. 旧ブリッジを起動
docker compose --profile openclaw up -d

# 4. brain を再起動
docker compose restart brain
```

---

## 既知の制限と対処法

### ブラウザ制御 (`control_browser`) が使えない

**影響**: brain が `control_browser` ツールを呼んだ場合、`{"success": false, "error": "501..."}` が返る。
**深刻度**: 低。brain は失敗として扱い、代替行動を取る。
**対処**: ブラウザ制御が重要な場合は openclaw-bridge を継続使用するか、localcraw-hems にブラウザ制御を追加実装する。

### ブラウザチェッカーが動かない

**影響**: `HEMS_BROWSER_CHECKERS` で設定したサービスの状態が MQTT に届かない。
**対処**: 対象サービスの API (REST/GraphQL) が使える場合は、カスタムチェッカーとして `src/hems/services.ts` に追加できる。

### CPU 周波数情報が 0 になる

**影響**: brain の WorldModel で `cpu.freq_mhz = 0` になる。
**深刻度**: なし。brain のどの判断ロジックも `freq_mhz` を参照していない。

### デスクトップ通知が届かない場合

`notify-send` がホスト側にインストールされていないか、DISPLAY 環境変数が未設定の場合に発生します。

```bash
# ホスト側に notify-send をインストール
sudo apt-get install libnotify-bin

# または docker-compose.hems.yml に DISPLAY を追加
environment:
  - DISPLAY=${DISPLAY:-:0}
```

### GPU メトリクスが取得できない

Docker コンテナからの GPU アクセスには NVIDIA Container Toolkit が必要です。
`docker-compose.hems.yml` の GPU セクション（コメントアウト済み）を参照してください。

---

## compose ファイルの恒久的な統合（オプション）

毎回 `-f` フラグを付けるのが煩わしい場合、`hems/infra/docker-compose.yml` に直接サービスを追加できます:

```yaml
# hems/infra/docker-compose.yml の services: セクションに追加
  localcraw-bridge:
    build:
      context: ../../localcraw      # パスを環境に合わせて調整
      dockerfile: Dockerfile
    container_name: hems-localcraw-bridge
    restart: always
    profiles: ["localcraw"]
    pid: "host"
    volumes:
      - /proc:/proc:ro
      - /sys:/sys:ro
    ports:
      - "${HEMS_PORT_OPENCLAW_BRIDGE:-8013}:8000"
    depends_on:
      mosquitto:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - PORT=8000
      - TZ=${TZ:-Asia/Tokyo}
      - MQTT_BROKER=mosquitto
      - MQTT_USER=${MQTT_USER:-hems}
      - MQTT_PASS=${MQTT_PASS:-hems_dev_mqtt}
      - OPENCLAW_METRICS_INTERVAL=${OPENCLAW_METRICS_INTERVAL:-10}
      - OPENCLAW_PROCESS_INTERVAL=${OPENCLAW_PROCESS_INTERVAL:-30}
      - HEMS_GMAIL_ENABLED=${HEMS_GMAIL_ENABLED:-false}
      - HEMS_GMAIL_EMAIL=${HEMS_GMAIL_EMAIL:-}
      - HEMS_GMAIL_APP_PASSWORD=${HEMS_GMAIL_APP_PASSWORD:-}
      - HEMS_GMAIL_INTERVAL=${HEMS_GMAIL_INTERVAL:-300}
      - HEMS_GITHUB_ENABLED=${HEMS_GITHUB_ENABLED:-false}
      - HEMS_GITHUB_TOKEN=${HEMS_GITHUB_TOKEN:-}
      - HEMS_GITHUB_INTERVAL=${HEMS_GITHUB_INTERVAL:-300}
      - HEMS_HA_URL=${HEMS_HA_URL:-}
      - HEMS_HA_TOKEN=${HEMS_HA_TOKEN:-}
    networks:
      - hems-net
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
```

その後は通常の compose コマンドで起動できます:

```bash
docker compose --profile localcraw up -d --build
```

---

## トラブルシューティング

### MQTT に接続できない

```bash
docker logs hems-localcraw-bridge | grep -i "mqtt\|connect\|error"
```

`MQTT connection failed` が出る場合:
- `mosquitto` コンテナが `healthy` 状態か確認: `docker compose ps mosquitto`
- `MQTT_USER` / `MQTT_PASS` が正しいか確認

### メトリクスが WorldModel に反映されない

```bash
# MQTT ブローカーを経由してトピックを確認
docker exec hems-mqtt mosquitto_sub \
  -h localhost -u hems -P hems_dev_mqtt \
  -t 'hems/pc/metrics/#' -v
```

データが届いているのに WorldModel に反映されない場合:
- brain のログでトピック処理エラーがないか確認: `docker logs hems-brain | grep ERROR`

### シェルコマンドがすべて失敗する

`pid: "host"` が設定されているか確認:

```bash
docker inspect hems-localcraw-bridge | grep -i pid
```

### `snapshot_available: false` が続く

起動直後はメトリクス収集に数秒かかります。
15 秒待っても変わらない場合:

```bash
docker exec hems-localcraw-bridge \
  node_modules/.bin/tsx src/cli.ts hems status
```

コンテナ内で直接メトリクスが取れるか確認します。
