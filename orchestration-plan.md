# タスク: 本番PostgreSQLとOAuth 2.1に対応し、公式MCPコネクタから安全に接続できる状態にする

- 決定: OAuth providerは外部SaaSではなく、自前の最小OAuth 2.1 Authorization Serverを採用する。無料枠や第三者設定への依存を避け、必要なAuthorization Code + PKCEとrefresh tokenをこのリポジトリ内で完結させるため。
- 作業対象: `/home/rayohsaka/.claude/jobs/00919bc8/tmp/trust_layer_build/` のみ。GoogleDriveパスは参照しない。
- 実行確認の制約: Codex作業者はnpm install/build/testを実行しない。変更後にClaude Code側で実行する。
- 委任の経緯: 2026-08-25に指定どおり `codex exec --model gpt-5.6-luna -s workspace-write -c 'model_reasoning_effort="xhigh"'` を2回試したが、内部app-server clientの読み取り専用ファイルシステムエラーで委任は開始できなかった。その後、オーナー承認によりTerraが直接実装へ切り替えた。

✅ T1: 現行構造・依存関係を調査して実装方針を確定する / 依存: なし / 検証: 現行の公開API、DB境界、サーバー起点を特定 / 担当: Terra
✅ T2: PostgreSQL adapterとトランザクション境界を実装する / 依存: T1 / 検証: DATABASE_URL時に実PostgreSQLを選択し、migrationを適用可能で、BEGIN/COMMIT/ROLLBACKを維持 / 担当: Terra
✅ T3: OAuth 2.1 resource/authorization serverを実装する / 依存: T1 / 検証: metadata、401 challenge、PKCE code flow、token検証・refreshを実装 / 担当: Terra
✅ T4: 設定外部化、fail-closed、テスト、ドキュメント、lockfileを更新する / 依存: T2, T3 / 検証: lockfileにpg依存を固定。registry無応答だったためClaude Code側のnpm ci整合性確認を残す / 担当: Terra
✅ T5: 静的レビューと修正を反復する / 依存: T2, T3, T4 / 検証: OAuth resource/issuer/audience/expiry、PKCE/refresh rotation、redirect URI完全一致、FK削除順、設定fail-closed、lockfile JSONを再確認。実行系の確認はT6へ残す / 担当: Terra
⬜ T6: Claude Code側で依存解決・ビルド・テストを確認する / 依存: T5 / 検証: コマンド結果を記録し、失敗時は原因を切り分ける / 担当: Claude Code

## guidance_version 付帯タグ対応（2026-08-26）

# タスク: guidance_version が2つの送信経路で任意・厳格に受け付けられ、永続化されるが、信頼性集計へ影響しない状態にする

✅ T1: 現行の入力schema・型・service・DB・schemaCatalog・テスト・migration境界を調査し、変更点と既存挙動を確定する / 依存: なし / 検証: 対象ファイル、永続化モデル、集計更新経路、テスト用DBの確認 / 担当: Luna
✅ T2: 共通schema定義、2つのinput schema、TypeScript型、serviceの付帯情報引き回し、DB保存、次番号migrationを実装する / 依存: T1 / 検証: guidance_versionが任意・パターン制約付きで、assessment/manifestsの永続化オブジェクトへ到達し、site_aggregates/applied_weight経路に追加参照がない / 担当: Luna
🔄 T3: schemaCatalog記述とserviceテスト（指定あり・なし・不正値・集計不変）を追加し、build/testを実行する / 依存: T2 / 検証: 新規ケースを含む全テストと標準ビルドが成功（service/schemaCatalog/traceability 21件は成功、HTTP listen系はsandbox制約で未完） / 担当: Luna
✅ T4: 変更内容を独立検証し、差分・schema参照・型/SQL整合・集計非関与・本番操作未実施を確認する / 依存: T3 / 検証: 変更ファイルとテスト結果を実ファイル・実行ログで照合 / 担当: オーケストレーター
❌ T5: Codexレビューゲート（medium: arch → diff）を通し、blocking issueがあれば修正して再レビューする / 依存: T4 / 検証: ok: true、blocking 0件 / 担当: Terraレビュー + Luna修正（Codex CLI内部app-serverがRead-only file systemで起動不能。補助read-onlyレビューはblockingなし、advisory対応済み）
✅ T6: IMPLEMENTATION_LOG.mdへ最終サマリーとテスト結果を追記し、未実施の本番DB migration・本番deployを明記して報告する / 依存: T5 / 検証: ログ末尾追記と成果物diffが確認可能 / 担当: オーケストレーター

### 試行記録

- Codex Luna委任: 内部app-server初期化が `Read-only file system` で失敗。
- cursor-agent振替: `api2.cursor.sh` のDNS解決が `EAI_AGAIN` で失敗。
- 内部SubAgent振替: 実装を保存したが、`npm ci` はregistryの `EAI_AGAIN` で依存取得できず、build/testは正本上で未実行。
- 独立検証: `/tmp` へ完全な既存依存をコピーし、build成功、service/schemaCatalog/traceability 21件成功。mcp/oauth 2件はsandboxのHTTP `listen EPERM` により失敗。
