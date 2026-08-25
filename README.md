# Claude Code コンテナ ワークベンチ

Windows 11 用の Electron デスクトップアプリです。Claude Code を Docker コンテナの中で動かし、**エンドポイント・モデル・API キーを用途ごとに差し替えて**使うためのものです。ローカル環境には Node も Claude Code も入れません。

英語版は [README.en.md](README.en.md) を参照してください。

![接続タブ](docs/screenshot-connect.png)

![ターミナル](docs/screenshot-terminal.png)

![プロファイル](docs/screenshot-profiles.png)

---

## これは何を解決するのか

以前の `claude-container`（bat ファイル + `docker compose`）と同じことを、GUI から一貫して行えるようにしたものです。変わった点:

|                        | 以前                                                | このアプリ                                                           |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| 設定変更               | VS Code でコンテナに入って `settings.json` を手編集 | プロファイルを選んで「適用」。書き込みは自動                         |
| オンボーディング       | 初回に手動で `hasCompletedOnboarding` を書く        | **起動のたびに自動で `true` を書き込む**                             |
| 起動済み cc への再接続 | 不可（`docker compose exec` で毎回新規）            | tmux セッションに**再接続**。タブを閉じても生きている                |
| 中身をいじる           | VS Code Remote Containers が必須                    | アプリ内にファイルブラウザ + エディタ。Dockerfile も UI から編集     |
| GitHub CLI             | イメージに同梱                                      | **入れない**。成果物は「ワークスペースを取り出す」で手動エクスポート |
| API キー               | `settings.json` に平文                              | OS の暗号化ストア（Windows は DPAPI）に保存                          |

---

## 必要なもの

- Windows 11 + **Docker Desktop**（起動していること）
- 開発する場合のみ: Node.js 22 以上

Docker Desktop さえ動いていれば、Node も Claude Code も Windows 側にインストールする必要はありません。

---

## セットアップ

```powershell
npm install
npm run build

# 開発中に動かす
npm run dev

# 配布用 (Windows x64 インストーラ) を作る
npm run dist:win
```

生成物は `release/` に出ます。

---

## 使い方

### 1. ビルドして起動する

「接続」タブで上から順に:

1. **Docker エンジン** — 緑になっていることを確認（なっていなければ Docker Desktop を起動）
2. **コンテナイメージ** → 「ビルド」（初回のみ、数分）
3. **コンテナ** → 「起動」

コンテナは `sleep infinity` で常駐するだけです。実際の作業は `docker exec` セッションの中で行われます。

### 2. エンドポイントとモデルを設定する

「プロファイル」タブで、用途ごとの組み合わせを作ります。

- **ベース URL** — Claude Code が末尾に `/v1/messages` を付けるので、**そこは含めない**でください。
  OpenRouter なら `https://openrouter.ai/api`（`/api/v1` ではありません）。
  入力欄の下に、実際に叩かれる URL が表示されます。
- **認証方式** — 既定は `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`）。承認プロンプトが出ないのでこちらを推奨します。`x-api-key` が必要なエンドポイントだけ `ANTHROPIC_API_KEY` に切り替えてください。
- **API キー** — OS の暗号化ストアに保存されます（Windows は DPAPI。ファイルを他の PC にコピーしても復号できません）。
- **モデル** — `ANTHROPIC_MODEL` と、`sonnet` / `opus` / `haiku` の各エイリアスの割り当て先。
- **コンテキスト長** — Claude Code が知らないモデル ID だと 200k と仮定して自動コンパクトしてしまいます。実際の長さを入れておくと、そこまで使い切れます。

「適用」を押すと、プロファイルが保存され、コンテナが動いていればその場で書き込まれます。

### 3. Claude Code を起動 / 再接続する

「接続」タブの **Claude Code を起動 / 再接続**、または「ターミナル」タブの同名ボタン。

押すたびに、起動の直前に以下が実行されます:

1. `~/.claude.json` に `hasCompletedOnboarding: true` などをマージ（既存の履歴は壊しません）
2. `~/.claude/settings.json` の `env` ブロックをプロファイルの内容で置き換え
3. `post-create.sh` を実行
4. tmux セッション（既定 `cc`）にアタッチ、なければ作成して Claude Code を起動

**タブを閉じても中の Claude Code は動き続けます。** 同じボタンを押せば同じセッションに戻ります。画面下部の「tmux セッション」一覧からも「接続」できます。

### 4. 成果物を取り出す

コンテナには GitHub CLI を入れていないので、取り出しは手動です。

- 「ファイル」タブ → **ワークスペースを取り出す** → 保存先フォルダを選択
- `<選んだフォルダ>/workspace_YYYYMMDD_HHMMSS/` にコピーされます

---

## 中身をいじる

### ファイルタブ

コンテナ内のファイルをそのまま閲覧・編集できます。`settings.json` / `.claude.json` / `CLAUDE.md` へのクイックリンク付き。

`settings.json` を手で編集しても、`env` **以外**のキー（`hooks`、`permissions`、`statusLine` など）は次回の書き込みでも残ります。`env` だけはプロファイルが正になります。

### イメージタブ

`Dockerfile` と `post-create.sh` を UI から編集できます。

- **Dockerfile** — イメージそのもの。編集したら「ビルド」→「接続」タブでコンテナを作り直すと反映されます。
- **post-create.sh** — **コンテナ起動のたびに**実行されます。git の名前設定、追加の npm グローバル、dotfiles などはここに。

編集内容は `%APPDATA%\cc-container-desktop\docker\` に保存され、アプリを更新しても消えません。「初期状態に戻す」で同梱版に戻せます。

### シェルとターミナル

「シェルを開く」で `bash -l` のタブが開きます。`sudo` はパスワードなしで使えます。

### VS Code で開く

「設定」タブ → **VS Code でコンテナを開く**。Dev Containers 拡張の "Attach to Running Container" と同じ方式です。`code` が PATH にない場合は URI が表示されるのでコピーして使ってください。

**devcontainer.json を書き出す** で、同じイメージ・同じボリュームを使う `.devcontainer/` 一式をホスト側フォルダに出力できます。

---

## コンテナの中身

|                |                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- |
| ベース         | Ubuntu 24.04                                                                            |
| Node.js        | 24 (NodeSource)                                                                         |
| Claude Code    | `@anthropic-ai/claude-code`（`/usr/bin/claude`)                                         |
| その他         | git, tmux, ripgrep, fd, jq, python3 + pipx, build-essential, htop, tree, vim-tiny, nano |
| ユーザー       | `claude` (uid/gid **1000**), パスワードなし sudo                                        |
| **GitHub CLI** | **入れていません**（仕様）                                                              |

`/home/claude` が名前付きボリューム `cc-workbench-home` になっています。ワークスペース（`/home/claude/workspace`）も設定もこの中なので、**コンテナを削除しても消えません**。消えるのは「ボリュームごと削除」を押したときだけです。

Claude Code は `/home/claude` の**外**（`/usr`）に入れてあります。ホームがボリュームだと、イメージを更新しても古いバージョンが残り続けてしまうためです。

---

## 動作確認

`tests/e2e/` に 4 つのスイートがあります。すべて **実際の Docker と実際のエンドポイント**に対して走ります。モックはありません。

| スイート        | 内容                                                                                                                                          | 項目数 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `workbench.mjs` | 基本の流れ: イメージ → コンテナ → 設定書き込み → `claude -p` が応答 → tmux 再接続                                                             | 28     |
| `deep.mjs`      | 意地悪系: 入力欄への実タイピング、コンテナ停止中の挙動、壊れた JSON、CJK ファイル名、権限ビット、ライフサイクル、エクスポート、イメージビルド | 88     |
| `live.mjs`      | 実モデル: ツール実行（ファイル読み書き・シェル）、モデル別名、GUI ターミナルでの対話、**再接続後に会話が続くか**                              | 17     |
| `packaged.mjs`  | `electron-builder` で固めたバイナリを起動し、`resourcesPath` からの解決を確認                                                                 | 9      |

```bash
CC_E2E_API_KEY=sk-or-v1-... npm run e2e:all     # Linux では xvfb-run -a を前に付ける
```

**OpenRouter + `stealth/ox-alpha`** で、全 142 項目の通過を確認済みです。特に:

- コンテナ内の Claude Code v2.1.241 が実際に応答し、**自分のツールでファイルを読み書きし、シェルを実行**できる
- オンボーディング画面・テーマ選択・信頼ダイアログが一度も出ない
- GUI のターミナルにキーボードで打ち込んで応答が返る
- タブを閉じて再接続したあと、**さっき教えた合言葉をモデルが覚えている**（会話が継続している）

他のプリセット（Anthropic 公式 / Moonshot / Z.ai / DeepSeek / MiniMax）は**未検証**です。プロファイル画面でも「未検証」と表示されます。

---

## CI とリリース

`.github/workflows/` に 2 つあります。

**`ci.yml`** — push と PR で自動実行。Prettier / oxlint（警告もエラー扱い）/ 型検査（キャッシュなし + 依存の型まで）/ ビルド、Linux でのパッケージ起動確認、Windows でのビルド確認。
実 API を使う E2E は手動トリガー時だけ走ります。リポジトリの Secrets に `OPENROUTER_API_KEY` を入れておくと、Actions タブから「Run workflow」で 3 スイートすべてが走ります。未設定なら警告を出してスキップします。

**`release.yml`** — **手動トリガーのみ**（Actions タブ → Release → Run workflow）。入力:

| 入力         | 既定  | 内容                                                                                       |
| ------------ | ----- | ------------------------------------------------------------------------------------------ |
| `version`    | 空    | `0.2.0` のように指定。空なら `package.json` の値。既存タグと衝突したらビルド前に失敗します |
| `draft`      | true  | 下書きとして作成。中身を確認してから自分で公開                                             |
| `prerelease` | false | プレリリース扱い                                                                           |
| `linux`      | false | Linux AppImage も添付                                                                      |

Windows インストーラ（NSIS, x64）をビルドし、`v<version>` タグの GitHub Release に添付します。バージョンは成果物にだけ反映され、ブランチにコミットは積みません。

---

## 開発

```bash
npm run typecheck      # tsc -b（main / renderer 両方）
npm run typecheck:ci   # キャッシュなし
npm run check:libs     # skipLibCheck を切って依存の型まで検査
npm run lint           # oxlint
npm run format         # prettier
npm run check          # 上記まとめて + build
```

### 構成

```
src/
  main/        Electron メインプロセス
    docker/    dockerode 経由の engine / container / files / terminal
    claude/    provision.ts — オンボーディングと settings.json の書き込み
    config/    設定と、safeStorage による API キー保存
  preload/     contextBridge（sandbox 有効、ipcRenderer のみ）
  renderer/    React 19 + xterm.js + CodeMirror 6
  shared/      main / preload / renderer 共通の型・IPC 契約・i18n
docker/        既定の Dockerfile と post-create.sh
tests/e2e/     Playwright(Electron) による E2E
```

レンダラーは `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`、CSP は `connect-src 'self'` のみ。Docker ソケットにもファイルシステムにも、レンダラーからは直接触れません。

---

## トラブルシューティング

**「Docker 未検出」と出る**
Docker Desktop が起動しているか確認してください。それでも駄目なら `docker version` が通るか確認を。

**モデルのエラーが出る**（"There's an issue with the selected model"）
ほぼ確実にベース URL です。`/v1` を付けていませんか。`https://openrouter.ai/api/v1` だと `/api/v1/v1/messages` を叩いて 404 になります。正しくは `https://openrouter.ai/api` です。入力欄の下に出る解決後の URL を確認してください。

**API キーが平文で保存されると警告が出る**
OS の暗号化ストアが使えない環境です。Windows 11 では通常 DPAPI が使えるので出ません（Linux では keyring が必要）。

**tmux セッションが消えた**
Claude Code が終了しても、ラッパーが `bash -l` に落ちるのでセッションは残ります。消えるのは、コンテナを停止・再起動したとき（tmux サーバーごと落ちるため）と「終了」を押したときです。

**イメージを更新したのに反映されない**
「接続」タブでコンテナを削除してから起動し直してください。イメージタグが変わっている場合は自動で作り直されます。
