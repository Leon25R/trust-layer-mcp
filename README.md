# Trust Layer Week 1 段階A MVP

合成データだけで動かす、5ツールのローカルMCPサーバーです。秘密・URL・生payloadはログや構造化レスポンスへ出しません。これは真偽判定器ではなく、保守的な観測シグナルです。

## インストール・実行

Node.js 20以上を用意し、このディレクトリで実行します。

```sh
npm install
npm test
npm run build
TRUST_LAYER_SECRET='replace-with-local-secret' TRUST_LAYER_DB_FILE='trust-layer-state.json' npm start
```

開発時は `npm run dev`、テスト監視は `npm run test:watch` です。デフォルトのエンドポイントは `http://127.0.0.1:8787/mcp`、非秘密の死活確認は `GET /healthz` です。listen hostは既定 `0.0.0.0`（Render等の外部到達用）で、ローカル限定にする場合だけ `HOST=127.0.0.1` を指定します。`PORT`、`HOST`、`TRUST_LAYER_SECRET`、`TRUST_LAYER_DB_FILE`、Origin許可リスト（コードの `TrustLayerOptions.allowedOrigins`）を設定してください。Bearer token は手動招待で発行し、`Authorization: Bearer <token>` にだけ付けます。デフォルトで許可するOriginは `http://localhost` と `http://127.0.0.1` です。

### オーナー用の合成token発行

サーバーと同じ `TRUST_LAYER_DB_FILE` を指定して、平文tokenを一度だけ標準出力へ表示します。標準出力をログへ転送せず、安全な一時メモへ手動コピーしてください。参加者credentialとしてDBに残るのはHMAC hashだけです。

```sh
TRUST_LAYER_SECRET='replace-with-local-secret' TRUST_LAYER_DB_FILE='trust-layer-state.json' \
  npm run issue-token -- --group owner-test
```

このコマンドの出力tokenは環境変数・README・ログへ貼り付けないでください。token発行後は同じsecret/DB fileでサーバーを起動します。

## 合成デモ

`TrustLayerService.issueSyntheticToken('demo-group')` が、平文を一度だけ返すローカルトークン発行方法です。保存されるのはサーバー秘密によるHMACだけです。発行したtokenで5ツールを呼び、同じ `research_id` は必ず小文字のUUID v4にします（例: `11111111-1111-4111-8111-111111111111`）。

1. `report_domain_assessment` を `minimal_observation` で送る。
2. 独立した複数ドメインの最小評価をまとめる場合は `report_domain_assessments_batch` に1〜5件を入れる。これはtransportだけをまとめ、各itemは単体評価と同じreceipt・冪等性・レート制限で処理します。配列内の結果は `item_index` 順に読み、`retry_directive` に従って再試行します。
3. `report_research_manifest` は `batch_count=1,batch_index=1,complete=true` とし、`source_count_total` とsource数を一致させる。`canonical_url` は `https://`、443（または既定ポート）、公開ドメインのみ、`sensitive` では使えない。URLを保存するのは14日TTLの短期source decisionだけです。複数sourceが一つのドメインを裏付ける場合はこちらを使います。
4. 必要なら完了済みmanifestのsource参照だけを `submit_local_verification` に渡す。これは自己申告で、集約重みを増やしません。
5. `lookup_domain_signal` で直近90日の状態を読む。返すのは `insufficient | consistent_support | mixed_observations | review_hold | withdrawn` と固定注意書きだけです。

同一token×domain×rubricの集約寄与は30日で最大1票相当、同一招待出所群も各domainで最大1票相当です。新規tokenは発行後7日かつ10寄与までは重み0.25、assessmentは50件/24時間かつ10件/10分、入力資源はitem slot単位で30件/10分・300件/24時間・無効5件/10分cooldownです。manifestの途中batchは14日で削除、receiptは30日、非個人rollupは97日で削除します。clockを注入できるため境界をテストできます。

## ファイルとschema

- `schemas/`: input 5種、success 5種、共通error、共通定義、source union。すべて `https://schemas.trust-layer.local/v0.3/` の絶対URIでAjv catalog解決します。batchのMCP inputSchemaだけはtransport用に寛容で、正式な外側契約とitem検証はservice/AJVが行います。
- `migrations/001_trust_layer.sql`: §5.1の14表を含むPostgreSQL互換migration。`pg-mem` adapterが起動時にこのmigrationを実行し、各合成リクエストの状態反映をbackup/restore transaction境界で行います。運用DBへ移行する際はこのSQLを正本にします。`TRUST_LAYER_DB_FILE`指定時は、pg-memの再起動橋渡しとしてparticipant token hashを含む状態を0600ファイルへ保存します（JSONをDBの代替表として使うものではありません）。
- `tests/`: schema独立検証、単一/multi batch原子遷移、冪等、TTL、rate/dedup/group上限、traceability。

## Week 1で未実装の境界

同意UI、DNS隔離egress/DNS再解決・redirectを含む外部再取得、robots/規約判定、独立監査の盲検再取得・反証corroboration、ドメイン管理者のDNS/.well-known異議受付、バックアップ物理消去証跡、監査操作UIは実装していません。`tests/traceability.test.ts` に各未実装項目と将来テスト名を対応づけています。したがって外部公開・実データ投入・課金・MCPクライアントへの信頼度%表示は行わないでください。
