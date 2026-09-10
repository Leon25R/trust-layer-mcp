# Trust Layer MCP：オーナー向けデプロイ・接続ガイド

最終確認日: 2026-08-25

このガイドは、Trust Layer MVP を**合成データだけ**で試すための手順です。外部公開、実データの入力、料金が発生する設定は対象外です。

結論から言うと、ホスティング先は **Render Free（アプリ）+ Neon Free（PostgreSQL）** を推奨します。リポジトリには`DATABASE_URL`で選択される実PostgreSQL adapterと自前OAuth 2.1 Authorization Serverを実装済みです。ただし、Neon・Render・Claude・ChatGPTを使う実環境接続はまだ確認していません。

したがって、このガイドは次の2段階です。

1. **必須の実装ゲートを満たす**（OAuth と実PostgreSQLを実装する）。
2. **Render + Neon にデプロイし、Claude と ChatGPT のコネクタ登録を行う**。

レガシーの Bearer token を使えるのは、現時点ではローカル又は任意ヘッダーを設定できる開発用クライアントだけです。Claude / ChatGPT のカスタムコネクタ接続には使いません。

## 1. 推奨構成と無料枠の確認

| 役割 | 採用 | 理由・注意点 |
|---|---|---|
| アプリ | Render Free Web Service | GitHub連携、Node.js、公開HTTPS、環境変数の設定が画面操作で完結する。15分無通信で停止し、次の接続で約1分の起動待ちがある。月750 free instance hours、ローカルファイルは再起動・停止・再デプロイで消える。無料Web Serviceに永続ディスク・シェル・one-off jobはない。 |
| DB | Neon Free PostgreSQL | 標準PostgreSQL接続文字列を使える。各プロジェクトに月100 CU-hours、アイドル時はcomputeがscale-to-zeroするため、少量の動作確認に向く。アプリからの最初の接続はDBの起動待ちがあり得る。 |
| DBの代替 | Supabase Free | PostgreSQL 500 MB・月5 GB egressで始められるが、1週間の低活動で一時停止される。無料は2アクティブプロジェクトまで。Supabaseを既に使っている場合だけ選んでよい。 |
| 採用しない | Render Free Postgres | 30日で期限切れになるため、接続検証後も残したいMVPには不向き。 |
| 採用しない | Fly.io | 現行の料金体系では全organizationにカード登録が必要で、VM・Volumeが従量課金。無料・セットアップの速さを優先する今回の条件に合わない。 |

RenderのスリープとNeonのscale-to-zeroはどちらも異常ではありません。コネクタ登録時・最初のtool callが遅いときは、まず `/healthz` を一度開いて1〜2分待ってから再試行します。長時間維持するSSE接続や本番SLAには無料枠を使わないでください。

公式情報: [Render Free](https://render.com/docs/free)、[Neon Free](https://neon.com/pricing)、[Supabase Free](https://supabase.com/pricing)、[Fly.io料金](https://fly.io/docs/about/pricing/)。

## 2. 先に満たす必須実装ゲート（実装済み・実環境確認は未完了）

このチェックがすべて済むまで、以下の「デプロイ」「Claude」「ChatGPT」手順には進まないでください。

- [x] **実PostgreSQL adapter**: `DATABASE_URL` があれば `pg` の実PostgreSQL adapterを選択する。起動時と`npm run migrate`で既存の`migrations/001_trust_layer.sql`をそのまま適用し、追加の`002_runtime_state.sql`でアプリ状態とOAuth状態を永続化する。実DBでの接続確認は未実施。
- [x] **DBトランザクション**: service操作を直列化し、単一batchの親作成からassessment記録・集約候補化までの完成stateを実PostgreSQLの`BEGIN` / `COMMIT` / `ROLLBACK`で一括永続化する。adapter契約テストは追加済みだが、Neon実機確認は未実施。
- [x] **OAuth 2.1 Resource Server**: 自前の最小Authorization Serverを採用し、401の`WWW-Authenticate`、`/.well-known/oauth-protected-resource`、Authorization Server Metadata、DCR、Authorization Code + S256 PKCE、issuer/audience/期限検証、scope 403を実装した。受信access tokenを外部サービスへ転送しない。
- [x] **refresh token**: `offline_access`を明示要求した場合だけrefresh tokenを発行し、保存値はHMAC化して一回ごとにrotationする。実際のClaude/ChatGPTとの再接続確認は未実施。
- [x] **Origin設定の外部化**: `TRUST_LAYER_ALLOWED_ORIGINS`はJSON配列またはCSVで必須設定にした。wildcard、空値、不正URLは拒否し、HTTPS（または明示的なloopback HTTP）だけを許可する。
- [x] **fail closed**: `TRUST_LAYER_SECRET`が未設定・空白・廃止済み既知値なら起動を失敗させる。OAuth signing secretと同一値も拒否する。
- [x] **再現可能なビルド**: `package-lock.json`に`pg 8.16.3`と`@types/pg 8.15.6`および必要なtransitive dependencyを固定した。registry無応答時にpackage metadataから復元したため、デプロイ前にネットワークが使えるClaude Code環境で`npm ci`を実行して整合性を確認すること。

OAuthの必須要件はMCPの公式Authorization仕様を正本にしてください。[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

> 重要: 上の実装ゲートは、現在のT5のschema / single-batch testとは別の「外部接続に必要な実装」です。ここを省略して、短いBearer tokenをURL、Git、Renderの環境変数、チャットに貼る運用へ変えてはいけません。

## 3. アカウントと値を準備する

以下はオーナー自身が行います。パスワード、DB接続文字列、tokenをこのリポジトリやissueに貼り付けないでください。

1. Render、Neon、GitHubのアカウントを作成し、GitHubにこのサービスを置くprivate repositoryを用意する。
2. Neonで **New project** を選び、Renderに近いregionを選ぶ。DB名は `trust_layer` のように用途が分かるものにする。
3. Neon Dashboardの **Connect** から、アプリ用のPostgreSQL接続文字列をコピーする。これは秘密情報である。Renderにだけ登録し、ローカルでは一時的な環境変数として使う。
4. ローカル端末で次を実行し、表示された文字列を安全なpassword managerへ保存する。表示結果をshell history、共有ログ、Gitに残さない。

```sh
openssl rand -base64 48
```

5. この実装は外部OAuth providerを使わない。`/oauth/register`でOAuth 2.0 Dynamic Client Registration（public client、redirect URI完全一致）を受け付けるため、Claude / ChatGPTがDCRを使う場合に固定client ID / client secretを設定しない。DCRを使わないクライアントは、オーナーが別途登録したredirect URIだけを使う設計であるため、接続画面の実際の値を確認してから登録機能を拡張する。

## 4. 実PostgreSQL版をローカルで確認する

この節は「必須実装ゲート」が完了してから実施します。

```sh
cd "hyoryu_ai_lab/GEO_LLMO_Business/プロダクト/trust_layer"
npm ci
npm run build
npm test
```

次に、Neonの接続文字列と作成したsecretを、現在のterminalだけに渡してmigrationとtoken発行を確認します。`DATABASE_URL`がある起動では実PostgreSQL adapterが選択され、`npm run migrate`は`001`と追加の`002`を順に適用します。

```sh
export DATABASE_URL='Neonからコピーした接続文字列'
export TRUST_LAYER_SECRET='手順3で生成した値'
npm run migrate
npm run issue-token -- --group owner-test
```

最後の一行が一度だけ表示する `tl_...` が、旧方式の検証tokenです。password managerに一時保存したらterminal表示を閉じます。OAuth実装後のClaude / ChatGPT接続では、このtokenを入力・貼り付けしません。各クライアントがOAuthで自分用のaccess tokenを取得します。

## 5. Renderへデプロイする

1. GitHubへ、実PostgreSQL対応・OAuth対応・`package-lock.json`を含む状態をpushする。monorepoの場合はRenderのRoot Directoryに次を入力する。

   ```text
   hyoryu_ai_lab/GEO_LLMO_Business/プロダクト/trust_layer
   ```

2. Render Dashboardで **New → Web Service** を選び、GitHub repositoryを接続する。
3. 次の値を設定する。

   | 項目 | 設定値 |
   |---|---|
   | Language | Node |
   | Branch | `main`（実際にpushしたbranch） |
   | Build Command | `npm ci && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | `Free` |

4. **Environment** で「Add Environment Variable」を使い、次だけを秘密値として登録する。`PORT` はRenderが渡すので追加しない。

   | 変数 | 値 |
   |---|---|
   | `NODE_ENV` | `production` |
   | `HOST` | `0.0.0.0` |
   | `DATABASE_URL` | Neonの接続文字列 |
   | `TRUST_LAYER_SECRET` | 手順3で生成したsecret |
   | `TRUST_LAYER_ALLOWED_ORIGINS` | 実装後に、Claude / ChatGPT用として確認済みのOriginだけをJSON又はCSVで指定 |
| `TRUST_LAYER_PUBLIC_BASE_URL` | `https://<Renderサービス名>.onrender.com`（末尾`/mcp`なし） |
| `TRUST_LAYER_OAUTH_ISSUER` | 上記と同じorigin（末尾pathなし） |
| `TRUST_LAYER_OAUTH_SIGNING_SECRET` | `TRUST_LAYER_SECRET`とは別に生成した32文字以上の秘密値 |
| `TRUST_LAYER_OAUTH_OPERATOR_USERNAME` | 自前OAuth認可画面にログインするオペレーター名 |
| `TRUST_LAYER_OAUTH_OPERATOR_PASSWORD` | 同認可画面の12文字以上のパスワード。ログ・Gitへ保存しない |

5. **Create Web Service** を押して、Deploy logで `npm run build` の成功を確認する。
6. 表示された公開URLの末尾に `/healthz` を付け、次が返ることを確認する。

   ```json
   {"status":"ok"}
   ```

7. `/mcp` はブラウザで開かない。Streamable HTTPのJSON-RPC endpointであり、MCP clientから接続する。
8. Renderが15分で停止した後は、`/healthz` を開いて起動待ちを済ませてからコネクタの **Scan Tools** / 再接続を行う。

### デプロイの停止条件

次のどれかなら、tokenを発行せず、先に実装を直します。

- `/healthz` は成功するが、再起動後に発行済みcredential又はreceiptが消える。
- アプリに `DATABASE_URL` を渡してもNeonに14表が作られない。
- `TRUST_LAYER_SECRET` 未設定で起動できる。
- OAuth未認証の `/mcp` リクエストがtool一覧又はtool実行まで進む。
- Render logにAuthorization header、DB接続文字列、payload、tokenが出る。

## 6. Claude（claude.ai / Claude Desktop）へ登録する

Claudeのremote custom connectorはAnthropicのクラウドから接続されます。Claude Desktopでも、remote connectorはローカルPCから接続されるわけではありません。公開HTTPSで到達可能なURLが必要です。

### 個人のPro / Max

1. claude.ai又はClaude Desktopで **Customize → Connectors** を開く。
2. **＋ → Add custom connector** を選ぶ。
3. MCP server URLに `https://<Renderサービス名>.onrender.com/mcp` を入力する。
4. OAuthを実装済みなら、必要に応じて **Advanced settings** でOAuth Client ID / Client Secretを入力する。DCR対応なら、入力不要な場合がある。
5. **Add** を押し、表示されるOAuth同意画面を完了する。
6. 新規チャットで左下の **＋ → Connectors** を開き、Trust Layerを有効にする。
7. まず合成payloadで `report_domain_assessment` を1回だけ試し、次に同じ`domain`で `lookup_domain_signal` を試す。`lookup_domain_signal` は未観測domainには`not_found`を返すため、順序を逆にしない。tool実行前の内容を確認する。

### Team / Enterprise

Ownerが **Organization settings → Connectors → Add → Custom → Web** から同じURLを追加します。その後、各利用者が **Customize → Connectors → Connect** を行います。

Claudeはremote MCPにHTTP SSEとStreamable HTTPをサポートし、認証は「認証なし」又はOAuthを文書化しています。カスタムBearer headerを保管・送信する設定手順は公式に記載されていません。そのため、現在の手動Bearer方式はClaude custom connectorでは**非対応として扱います**。

公式手順: [Claude custom connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## 7. ChatGPTへ登録する

2026-08-25時点で、ChatGPTのfull MCP custom app / developer modeは、公式案内では **Business と Enterprise / Edu のChatGPT Web workspace** 向けです。個人のFree / Plus / Proアカウントに同じ画面があるとは確認できません。個人アカウントだけの場合は、この節を進めず、利用可能なworkspaceを用意するか、OpenAIの現行仕様を確認してください。

1. Businessならworkspace admin / ownerとして、**Workspace Settings → Permissions & Roles → Connected Data Developer mode / Create custom MCP connectors** を有効にする。
2. **Workspace Settings → Apps → Create** を開く（許可された利用者は **Settings → Apps → Create**）。
3. endpointに `https://<Renderサービス名>.onrender.com/mcp` を入力する。
4. 認証方式はOAuthを選ぶ。OAuth認可画面が出たら完了する。refresh tokenを使うproviderでは `offline_access` 相当が有効であることを確認する。
5. **Scan Tools** を実行する。4ツールが読み込まれ、入力schemaだけが登録されていることを確認する。
6. **Create** を押す。最初はDraft / Devとして保存する。
7. 新しいchatでtools menuからDev appを選び、合成dataの `report_domain_assessment` を一つ実行してから、同じ`domain`の `lookup_domain_signal` を実行する。書き込み確認画面が出たら、引数を確認してから承認する。

ChatGPTのアプリ作成画面は「認証方式を選択」と案内しており、OAuthのrefresh token設定を明記しています。一方、カスタムコネクタ画面で任意の固定 `Authorization: Bearer ...` headerを永続設定する公式手順は確認できません。APIのremote MCP toolには任意headerを渡せる仕様がありますが、これはChatGPT UIのカスタムapp設定と同一ではありません。よって、UI接続ではBearer tokenを前提にしないでください。

公式手順: [ChatGPT developer mode and full MCP connectors](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)

## 8. 接続確認チェックリスト

以下を順に満たしたら、本人のClaudeとChatGPTからの接続確認は完了です。

- [ ] Renderの `/healthz` が200 / `{ "status": "ok" }` を返す。
- [ ] Neonにmigrationの14表が存在し、Render再起動後もtest用token / 合成receiptが残る。
- [ ] OAuth未認証リクエストが401とProtected Resource Metadataの案内を返す。
- [ ] ClaudeでOAuth同意後に4ツールをscanできる。
- [ ] Claudeで合成`report_domain_assessment`の後に`lookup_domain_signal`を実行できる。
- [ ] ChatGPT Business / Enterprise / Edu workspaceでOAuth同意後に4ツールをscanできる。
- [ ] ChatGPTで合成`report_domain_assessment`の後に`lookup_domain_signal`を実行できる。
- [ ] 各クライアントで、tool responseにtoken、token hash、canonical URL、raw payload、エラー詳細が含まれない。
- [ ] Render logとprovider logに秘密値・payloadを出していない。

## 9. 現行Bearer tokenを使う場合の限定ルール

`npm run issue-token`はOAuth移行後も、任意headerを設定できるローカル回帰確認だけに残す互換コマンドです。公式コネクタの認証回避には使いません。

```sh
cd "hyoryu_ai_lab/GEO_LLMO_Business/プロダクト/trust_layer"
export DATABASE_URL='Neonの接続文字列'
export TRUST_LAYER_SECRET='Renderと同じsecret'
npm run issue-token -- --group owner-test
```

このtokenは以下の用途だけに限定します。

- 任意headerを明示設定できる開発用MCP clientでの短時間の確認
- OAuth移行前のローカル回帰確認

Claude / ChatGPTのカスタムコネクタにtokenを貼り付ける、URL queryに付ける、Gitに保存する、Renderの公開ログへ出す運用は禁止です。外部コネクタの本接続はOAuth実装後に、各アカウントのOAuth同意で行います。

## 10. 困ったときの切り分け

| 症状 | 最初に確認すること |
|---|---|
| 初回Scan Toolsがtimeoutする | Renderがsleep中ではないか。`/healthz`を開いて約1分待ち、再度scanする。 |
| 401 / 認証画面が出ない | OAuthのProtected Resource Metadata、issuer、redirect URL、token audienceを確認する。Bearer tokenで回避しない。 |
| 403 `origin_not_allowed` | 実際のOriginを安全に確認してからallowlistへ1件だけ追加する。`*`にはしない。 |
| 再起動後にtoken / receiptが消える | 状態ファイルを使っている。デプロイを止め、実PostgreSQL adapterへ戻る。 |
| ChatGPTにCreateがない | 個人アカウントではなく、Developer modeを許可したBusiness / Enterprise / Edu workspaceか確認する。 |
| Tool一覧は見えるが実行が失敗する | OAuth tokenのissuer/audience/scope、Neon接続、Render environment、schema validation errorを秘密値なしで確認する。 |

このMVPは保守的な観測シグナルであり、真実性・安全性・推奨・法務/医療判断を保証するものではありません。接続確認が済んでも、実データや一般公開へ移行する前に、正本設計書の段階ゲートと未実装項目を別途完了してください。
