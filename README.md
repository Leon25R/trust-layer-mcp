# Trust Layer

Trust Layer は、AI エージェントが公開 Web を調査するときに得た「このドメインを根拠として採用した」「一次資料との矛盾や更新切れのため採用しなかった」「判断材料が足りなかった」という最小限の利用観測を、ドメイン単位で扱う MCP サービスです。

これは、サイトの真実性・安全性・検索順位を採点するサービスではありません。共有観測を次の調査でどう扱うべきか、特に一次資料を追加確認すべきかを判断するための、保守的な補助シグナルを目指します。公開 schema でも `not_a_truth_rating` を明記しています。

## なぜ作ったのか

この取り組みは、漂流AI Lab の GEO/LLMO 関連事業の一部として、2026年8月に始まりました。発想の原点は、事業オーナーの次の言葉です。

> AmazonやHotpepperのように、多くの利用者が実際に利用し、評価を付けることで、完全に正確ではなくとも、ある程度そのサービスの良し悪しが分かる仕組みがあります。現在のAIの問題として、出力される情報の信頼性の問題があると考えており、Web上に存在する全てのドメインについても、同様の評価システムを設計することで、各ドメインについて多数のAIが評価し、それらの評価を公開することで、より信頼性の高いドメインから優先的に情報を取得できるようになり、結果として出力の信頼性も高まるのではないかと考えています。

理想は、多数の**独立した** AI エージェントによる観測が積み重なり、完全な正解ではないものの、追加確認の優先度を考える手掛かりが育つ状態です。根拠が薄い、矛盾がある、観測が少ないドメインをそのまま鵜呑みにせず、一次資料へ立ち戻る。そうした小さな判断の積み重ねが、AI の回答全体の信頼性を少しでも高められるかを検証します。

2026年9月末までの M&A（売却）可否を検証する事業計画とも接点を持っています。ただし、M&A の成立やプロダクト需要は未検証です。また、証拠付き公式ファクト MCP という路線と、Trust Layer のドメイン利用観測は同一の主張として混同しません。

## 何をするか

AI エージェントは、実際の調査に基づき、認証付き MCP ツールを通じてドメイン単位の観測を送れます。

- `report_domain_assessment`: 1ドメインの最小観測を送信する
- `report_domain_assessments_batch`: 独立に評価した1〜5ドメインをまとめて送信する
- `report_research_manifest`: 1ドメインを複数ソースで扱った場合の任意の詳細証跡を送信する
- `submit_local_verification`: 利用者側で行った自己検証を固定形式で送信する
- `lookup_domain_signal`: 直近90日を対象にした保守的な状態を読む

通常の最小観測には、質問文、会話、ページ本文、検索語、API キーを含めません。送るのは正規化したドメイン、閉じた列挙値の採否・理由、固定されたモデル名などです。`S`（根拠として採用）、`R`（矛盾・更新切れ等で不採用）、`U`（判断材料不足）を区別し、`U` を反対票には読み替えません。

集計では、同じ出所からの反復投稿で多数決の見せかけを作らないよう、出所グループごとの寄与をドメイン当たり最大1票相当に圧縮します。内部では Beta 事後分布なども用いますが、これはサイトの「真実確率」ではありません。独立性、文脈の違い、自己申告の限界を解決したものでもありません。

## 匿名で見られる公開閲覧

認証付き MCP とは別経路として、登録不要の公開閲覧 API と簡易 Web UI を本番で提供しています。

- Web UI: <https://trust-layer-mvp.onrender.com/>
- API: `GET https://trust-layer-mvp.onrender.com/api/public/domain-signal?domain=example.org`

この API は認証もデータベース書込みも行わず、入力されたドメインについて次の4値だけを返します。

| `publication_status` | 意味 |
|---|---|
| `no_public_observations` | 公開できる共有観測はない |
| `limited_observations` | 共有観測はあるが、判断材料はまだ限られる |
| `under_review` | 公開シグナルは確認中 |
| `withdrawn` | 公開シグナルは撤回済み |

支持率、`S/R` の内訳、出所グループ数、モデル構成、投稿者、元の観測内容は返しません。ドメインの一覧・検索 API も提供しません。これは、少数の観測や内部の集計詳細を、もっともらしい評価や列挙可能なデータセットに変えてしまわないための境界です。

## 全体の統計（ドメイン別ではなく、集計のみ）

個別ドメインの検索とは別に、サービス全体の規模感を確認できる集計専用のエンドポイントも提供しています。

- API: `GET https://trust-layer-mvp.onrender.com/api/public/stats`

累計の観測受理数、公開基準を満たしているドメイン数、活動中の出所グループ数を、少数時に投稿時刻等を推測されないよう帯域表示（`0` / `1-9` / `10-49` など）で返します。個別ドメイン名やその内訳は一切含みません。現時点ではいずれも `0` です（後述）。

人が見やすい形で確認したい場合は、以下のページをご覧ください。

- 統計ページ: <https://trust-layer-mvp.onrender.com/stats>

## 現在地

動くインフラと、価値を示すデータ量は別です。現状を誇張しません。

| 項目 | 現状 |
|---|---|
| 認証付き MCP | 本番稼働中。投稿・参照は認証が必要 |
| 匿名公開閲覧 | `/api/public/domain-signal` と簡易 Web UI を本番提供中 |
| 全体統計 | `/api/public/stats`（JSON）と `/stats`（閲覧用ページ）を本番提供中。現時点は累計観測・対象ドメイン・出所グループのいずれも `0` |
| セキュリティ確認 | 公開閲覧APIは2回、統計APIは3回のレビュー反復でいずれも blocking 0件に収束。95テストが PASS |
| 公式情報入口 | 運営者が事前確認した `source-routes.json` は空配列（0件） |
| 実データ・外部利用者 | 実質ゼロ。外部の実利用者はまだいない |
| 投稿参加 | 運営者が個別発行するトークン方式。セルフサインイン投稿は未実装 |

Google/GitHub 等によるログインは、GitHub を含む案を設計済みですが、まだ実装していません。仮にログインを追加しても、ログインできたことを独立性の証明にはしません。自己登録者全体の寄与を集計上1票相当に制限するなど、Sybil 耐性を優先する方針です。

したがって、現時点の Trust Layer は「実運用できる経路はあるが、データと利用者はこれから」の段階です。公開 API に観測がないことも、対象サイトの正しさ・安全性・価値を意味しません。

## 一緒に検証してくださる方へ

Claude Code などの AI エージェントを MCP で接続し、実際の調査でお使いいただける協力者を探しています。現時点ではセルフサインインによる投稿は未実装のため、投稿用トークンが必要な場合は運営者へご連絡ください。

Issue、改善提案、設計への異論、PR を歓迎します。特に次のようなフィードバックが役立ちます。

- MCP 接続や実調査で生じた障害・導入負担
- 「この表示では一次資料の確認につながらない」という具体例
- 投稿の同意、撤回、不正対策、独立性の扱いに関する懸念
- ドメイン列挙や安易なスコア化を避けたまま、どう有用性を育てられるかという提案

データが少ない今は、完成した評価サービスを利用する段階ではありません。だからこそ、何を公開し、何を公開しないか、どんな観測なら次の調査に役立つかを、初期の参加者と一緒に形作れる段階です。過信を生まない仕組みのまま実用性を育てられるか、率直な検証にご協力ください。

## 明確にしないこと

- 特定サイトの真実性・安全性・一般的な品質を判定・保証しない
- AI の回答の正しさ、検索順位、独立した多数の存在を保証しない
- 少数の投稿、同一出所の反復、ログイン数を信頼性の証明にしない
- 公開 API を使って観測済みドメインを列挙・検索できるようにはしない

Trust Layer の出力は、判断の代替ではなく「次に一次資料・発行者・更新日を確かめるべきか」を考えるための補助情報です。

## 動かし方（開発者向け）

Node.js 20以上を用意し、このディレクトリで実行します。

### インストール・テスト・ビルド

```sh
npm install
npm test
npm run build
```

`npm test` は Vitest の一回実行、`npm run build` は `tsc -p tsconfig.json` によるビルドです。開発サーバーは `npm run dev`、テスト監視は `npm run test:watch` で起動します。本番相当の起動は、ビルド後に `npm start` を実行します。

### ローカル起動

ローカルでは `DATABASE_URL` を指定しない場合、PostgreSQL互換の `pg-mem` adapter が使われます。`TRUST_LAYER_DB_FILE` を指定すると、サービス状態を0600のJSONファイルへ保存できます。Postgres互換のローカルadapterではOAuth runtime stateはメモリ上だけに保持されます。これは開発・テスト用のフォールバックであり、本番では使用しません。

OAuth 2.1の認可サーバーも起動時に設定が必要です。以下はローカルでの最小設定例です。秘密値は実際には十分な長さのランダム値へ置き換え、ログやリポジトリへ保存しないでください。

```sh
export NODE_ENV='development'
export HOST='127.0.0.1'
export PORT='8787'
export TRUST_LAYER_DB_FILE='trust-layer-state.json'
export TRUST_LAYER_SECRET='replace-with-a-random-secret'
export TRUST_LAYER_ALLOWED_ORIGINS='["http://127.0.0.1"]'
export TRUST_LAYER_PUBLIC_BASE_URL='http://127.0.0.1:8787'
export TRUST_LAYER_OAUTH_ISSUER='http://127.0.0.1:8787'
export TRUST_LAYER_OAUTH_SIGNING_SECRET='replace-with-a-different-random-secret-of-32-or-more-characters'
export TRUST_LAYER_OAUTH_OPERATOR_USERNAME='local-operator'
export TRUST_LAYER_OAUTH_OPERATOR_PASSWORD='replace-with-a-password-of-12-or-more-characters'

npm start
```

デフォルトの `HOST` は `0.0.0.0`、`PORT` は `8787` です。ローカル起動時の MCP endpoint は `http://127.0.0.1:8787/mcp`、死活確認は `GET http://127.0.0.1:8787/healthz` です。`TRUST_LAYER_PUBLIC_BASE_URL` と `TRUST_LAYER_OAUTH_ISSUER` は同じorigin（scheme・host・port）で、pathを含めないでください。開発環境ではOAuth URLに限り明示的なloopback HTTPを使用できますが、本番はHTTPSが必要です。

### 本番起動（Render + Neon）

本番では `DATABASE_URL` にNeonの接続文字列を指定してください。`NODE_ENV=production` では `DATABASE_URL` がない場合に起動を拒否し、`pg-mem` と状態ファイルは選択されません。Renderでは `PORT` が注入されるため、通常は手動設定しません。

```sh
npm ci
npm run build
DATABASE_URL='postgresql://...' npm run migrate
npm start
```

`npm run migrate` は `DATABASE_URL` を必須とし、実PostgreSQLへ `001_trust_layer.sql`、`002_runtime_state.sql`、`003_guidance_version.sql` を順に適用します。アプリ起動時のPostgreSQL adapterも、未適用のmigrationを同じ順序で適用します。

### 環境変数

| 変数 | 必須条件・意味 |
|---|---|
| `NODE_ENV` | 本番では `production` を指定する。production時は `DATABASE_URL` を必須にし、OAuthのloopback HTTPを許可しない。 |
| `PORT` | listenするポート。未指定時は `8787`。RenderではRenderが設定する値を使う。 |
| `HOST` | listenするhost。未指定時は `0.0.0.0`。ローカル限定時は `127.0.0.1` を指定する。 |
| `DATABASE_URL` | 指定時は実PostgreSQL adapterを選択する。`NODE_ENV=production` では必須。Neonの接続文字列を指定する。 |
| `TRUST_LAYER_DB_FILE` | `DATABASE_URL`がなくproductionでもない場合の開発・テスト用状態ファイル。productionでは使わない。 |
| `TRUST_LAYER_SECRET` | 必須。Trust LayerのHMAC等に使う秘密値。未設定・空白・廃止済み開発デフォルト値は拒否する。OAuth signing secretとは別の値にする。 |
| `TRUST_LAYER_ALLOWED_ORIGINS` | test環境以外では必須。JSON配列またはCSVの非空allowlist。`*`、重複、不正URLは拒否し、HTTPS（またはloopbackのHTTP）だけを許可する。 |
| `TRUST_LAYER_PUBLIC_BASE_URL` | 必須。公開origin。pathなしの絶対URL。productionではHTTPS。 |
| `TRUST_LAYER_OAUTH_ISSUER` | 必須。OAuth issuer。`TRUST_LAYER_PUBLIC_BASE_URL`と同じoriginで、pathなしの絶対URL。 |
| `TRUST_LAYER_OAUTH_SIGNING_SECRET` | 必須。32文字以上。`TRUST_LAYER_SECRET`とは異なる値にする。 |
| `TRUST_LAYER_OAUTH_OPERATOR_USERNAME` | 必須。OAuth認可画面のオペレーター名。空白不可、160文字以下。 |
| `TRUST_LAYER_OAUTH_OPERATOR_PASSWORD` | 必須。OAuth認可画面のパスワード。12文字以上。ログ・Gitへ保存しない。 |

旧READMEにあったコード側の `TrustLayerOptions.allowedOrigins` は、HTTPサーバーを環境変数で起動する利用者が設定する環境変数名ではありません。実行時は `TRUST_LAYER_ALLOWED_ORIGINS` を指定してください。また、本番の永続化先は `TRUST_LAYER_DB_FILE` ではなく `DATABASE_URL` です。

### endpointと認証

- `/mcp`: Streamable HTTPのMCP endpoint。OAuth access tokenを `Authorization: Bearer <token>` で送信し、`trust_layer:tools` scopeが必要です。
- `/healthz`: 認証不要の死活確認。成功時は `{"status":"ok"}` を返します。
- `/`: 匿名公開閲覧のWeb UI。
- `/stats`: 匿名公開の統計ページ。
- `GET /api/public/domain-signal?domain=example.org`: 匿名のドメイン状態参照。
- `GET /api/public/stats`: 匿名の集計統計。
- `POST /api/public/feedback`: 匿名フィードバックの受付。現行実装は受理を返すだけで、投票・ドメイン状態・自由記述を保存しません。
- `/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`、`/oauth/authorize`、`/oauth/token`: MCP connector向けのOAuthメタデータ・登録・認可・token endpoint。

### `issue-token` コマンド

`issue-token` は、`TrustLayerService`のローカル／互換回帰確認用に、参加者tokenを一度だけ標準出力へ表示するCLIです。グループ名を省略すると `owner-local` になります。

```sh
# 開発用pg-mem + 状態ファイル
TRUST_LAYER_SECRET='same-local-secret-used-by-the-service' \
TRUST_LAYER_DB_FILE='trust-layer-state.json' \
  npm run issue-token -- --group owner-local

# DATABASE_URLを使う場合（本番相当）
DATABASE_URL='postgresql://...' \
TRUST_LAYER_SECRET='same-secret-used-by-the-service' \
  npm run issue-token -- --group owner-test
```

CLIが保存するのはtokenのhashで、平文tokenは一度だけ出力されます。出力をログ・環境変数・README・Gitへ貼り付けないでください。現在のHTTP `/mcp` はOAuth access tokenを検証するため、このCLIで発行したtokenをOAuthの代わりに公式connectorへ設定する用途には使いません。

### レート制限・保持期間

公開HTTPの制限はプロセス内で、source keyにはsocket peer addressを使います。Renderの複数インスタンスをまたぐ共有制限ではありません。

- 全HTTPリクエスト: 1 sourceあたり60件/60秒、全体300件/1秒、同時実行32件。sourceごとの内部カウンター容量は1024です。
- `GET /api/public/domain-signal`: 1 sourceあたり30件/60秒。キャッシュミスは全体5件/1秒です。
- `GET /api/public/stats`: 1 sourceあたり30件/60秒。
- `POST /api/public/feedback`: 1 sourceあたり10件/日。
- 公開APIのrequest body上限は8 KiB、`/mcp`のrequest body上限は64 KiBです。

認証済みMCP toolの内部制限はparticipant単位です。

- `report_domain_assessments_batch` は1回に1〜5 item。入力resourceは30 item slot/10分、300 item slot/24時間。無効入力が5 item slot/10分に達すると10分のcooldownです。
- assessment受理は10 item/10分、50 item/24時間です。batchはitem数分のslotを消費します。
- 同じparticipant token × domain × rubricの寄与は重複排除されます。rolling 90日集計ではprovenance groupごとの寄与をdomainあたり最大1.0相当に圧縮します。
- participantの寄与weightは、発行から7日経過かつ累計10寄与に達するまで0.25、両方を満たすと1です。

保持期間は、manifestが14日、assessment receiptが30日、集計rollupが97日、research id tombstoneが30日です。これらはサービスのretention処理で削除されます。

## ファイルとschema

- `src/`: TypeScript実装。`server.ts`がHTTP/MCP/OAuth route、`service.ts`がtool処理と集計、`db.ts`がPostgreSQL／pg-mem adapter、`config.ts`がsecret・origin・URL設定、`oauth.ts`がOAuth 2.1、`abuseControls.ts`が公開HTTPの濫用制御を担当します。
- `schemas/`: JSON Schemaは14ファイルです。5 MCP toolのinput/success schemaが各5組、共通定義の `common-defs.json`、共通エラーの `common-error.json`、manifest source entryの `manifest-source-entry-v0.3.json`、公開閲覧用の `public-domain-signal-v1.success.json` があります。schema IDは `https://schemas.trust-layer.local/v0.3/` 配下で、`src/schemaCatalog.ts` がAjv catalogとして読み込みます。batchのMCP inputSchemaはtransport envelope用に寛容ですが、itemごとの正式な検証と外側契約の検証はservice／Ajvで行います。
- `migrations/001_trust_layer.sql`: PostgreSQL互換の正規14表（participants、sites、aggregates、rollups、receipts、manifests、source decisions、verification、holds、model map等）を作成します。
- `migrations/002_runtime_state.sql`: アプリ状態用 `trust_layer_runtime_state` とOAuth状態用 `trust_layer_oauth_runtime_state` の2表を追加します。
- `migrations/003_guidance_version.sql`: `assessment_event_receipts` と `research_manifests` に任意の `guidance_version` 列を追加します。
- `tests/`: `mcp.test.ts`、`oauth.test.ts`、`publicAccess.test.ts`、`schemaCatalog.test.ts`、`service.test.ts`、`traceability.test.ts` の6ファイルです。MCP／OAuth／公開アクセス、schema catalog、migration・永続化・transaction、rate・dedup・group上限・TTL、未実装境界のtraceabilityを検証します。
- `public/`: 匿名公開閲覧と統計ページのHTML/JavaScript、`data/source-routes.json`: 運営者が確認した公式情報入口の定義です。

本番のmigration適用と状態永続化には `DATABASE_URL` の実PostgreSQLを使います。`TRUST_LAYER_DB_FILE` は `pg-mem` の再起動橋渡しを行う開発・テスト用であり、本番DBの代替ではありません。
