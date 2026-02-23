## PC 状態確認
Keywords: cpu, gpu, memory, ram, disk, temperature, process, pid, 負荷, 温度, メモリ, ディスク, プロセス

PC のリソース状態を確認します。`get_pc_status` でスナップショットを取得し、`get_pc_processes` でプロセス一覧を取得できます。

高負荷時は原因プロセスを特定してユーザーに報告してください。

## スマートホーム制御
Keywords: light, 照明, 空調, climate, temperature, switch, cover, カバー, ブラインド, home assistant, HA, entity

Home Assistant 経由でデバイスを制御します。`ha_list_entities` でエンティティを確認し、`ha_call_service` で制御します。

よく使うサービス:
- `light.turn_on` / `light.turn_off` / `light.toggle`
- `climate.set_temperature` (data: `{"temperature": 24}`)
- `cover.open_cover` / `cover.close_cover`
- `switch.turn_on` / `switch.turn_off`

## 環境センサー監視
Keywords: sensor, 温度, 湿度, co2, 二酸化炭素, 空気, air, mqtt, hems

MQTT トピックからセンサーデータを読み取ります。`mqtt_subscribe` で `hems/+/sensor/#` を購読し、現在値を確認します。

警告基準:
- 温度 > 30℃: 熱中症リスク
- CO2 > 1500ppm: 換気が必要
- 湿度 < 30% または > 70%: 不快・カビリスク

## サービス通知確認
Keywords: gmail, github, メール, 通知, notification, unread, 未読

`mqtt_subscribe hems/services/+/status` でサービス状態を確認できます。

## シェル操作
Keywords: shell, command, run, bash, terminal, コマンド, 実行, script

シェルコマンドを実行します。事前に `get_pc_status` で CPU 負荷を確認し、高負荷時は重い処理を避けてください。

安全なコマンド例: `ls`, `df -h`, `free -h`, `uname -a`, `date`, `git status`

## ファイル管理
Keywords: file, ファイル, read, write, directory, フォルダ, 検索, search

ローカルファイルの読み書きを行います。書き込み前は必ず内容を確認し、重要ファイルのバックアップを提案してください。
