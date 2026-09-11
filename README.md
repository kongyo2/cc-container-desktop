# Claude Code コンテナ ワークベンチ

Claude Code を Docker コンテナの中で動かす Windows 11 向け Electron アプリ。作業は「タスク」単位で、タスクごとに専用のコンテナとホームボリュームを持ちます。コンテナは固定のベースイメージから作られ、タスクごとに「環境」(環境変数とセットアップスクリプト) を選びます。エンドポイント・モデル・API キーはプロファイルとしてタスクに割り当てます。ホストには Node も Claude Code も入れません。

[English](README.en.md)

## 使い方

1. Docker Desktop を起動し、「環境」でベースイメージをビルドします (初回のみ。全ツールチェーンを入れるので数十分かかります)。
2. 「プロファイル」でエンドポイントと API キーを設定します。
3. 必要なら「環境」で環境を作ります。名前、`.env` 形式の環境変数、セッション開始時に走る Bash のセットアップスクリプトを持ちます。最初から「環境1」が 1 つあります。
4. 左上の「+」でタスクを作ります。環境を 1 つ選び、空のワークスペースで始めるか、公開 Git リポジトリを clone します。
5. タスク画面の「Claude Code」でコンテナ内の tmux セッションに入ります。タブを閉じてもアプリを閉じても Claude Code は動き続け、同じボタンで再接続できます。
6. ファイルやフォルダはタスク画面へドロップ (または「取り込む」ボタン) でワークスペースにコピーし、成果は「取り出す」でホストのフォルダに書き出します。

## ベースイメージ

すべてのタスクは同じ固定イメージから作られます。中身はアプリに同梱の `docker/Dockerfile` で決まり、アプリからは編集しません。Claude Code のクラウド環境と同じ構成です。

| カテゴリ         | 内容                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| Python           | Python 3.x、pip、poetry、uv、black、mypy、pytest、ruff                   |
| Node.js          | 20、21、22 (npm、yarn、pnpm、bun、eslint、prettier、chromedriver)        |
| Ruby             | 3.1、3.2、3.3 (gem、bundler、rbenv)                                      |
| PHP              | 8.3 と Composer                                                          |
| Java             | OpenJDK 21、Maven、Gradle                                                |
| Go               | Go (モジュール対応)                                                      |
| Rust             | rustc と cargo                                                           |
| C/C++            | GCC、Clang、cmake、ninja、conan                                          |
| Docker           | docker、dockerd、docker compose                                          |
| データベース     | PostgreSQL 16、Redis 7.0                                                 |
| ユーティリティ   | git、gh、jq、yq、ripgrep、tmux、vim、nano                                |

Node.js は `/opt/node20`、`/opt/node21`、`/opt/node22` にあり、既定で 22 が `PATH` に入っています。別のバージョンを使うときは、その `bin` (例: `/opt/node20/bin`) を `PATH` の先頭に足すよう Claude に頼んでください。PostgreSQL と Redis は `sudo service postgresql start` / `sudo service redis-server start` で起動します。Docker デーモンはコンテナ内では起動できません。

「Claude Code を更新」は Claude Code とグローバルの npm ツールの層だけを入れ直します。

## 環境

環境は「名前」「環境変数 (`.env` 形式)」「セットアップスクリプト」の組です。

- 環境変数はタスクのコンテナを作るときに設定され、コンテナ内のすべてのプロセス (シェル、Claude Code、そのツール) に渡ります。
- セットアップスクリプトは、コンテナを作った直後 (clone のあと、Claude Code を開く前) にワークスペースで `claude` ユーザーとして 1 回だけ実行されます。停止・起動では再実行されず、「作り直す」で再実行されます。失敗した場合は次の起動時にもう一度実行します。
- 環境への変更は新しいコンテナに適用されます。すでにあるタスクには「環境更新あり」が出るので、「作り直す」でホームボリュームを保ったまま反映します。
- 環境はアーカイブできます。アーカイブ済みの環境は新しいタスクから選べませんが、使っているタスクはそのまま動きます。タスクが使っていない環境だけ削除できます。

## タスクとデータの置き場所

| もの                       | 場所                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ワークスペース・設定・履歴 | タスクごとの Docker ボリューム `cc-task-<id>-home` (`/home/claude`)                                                    |
| コンテナ                   | `cc-task-<id>`。停止しても削除しない限りボリュームは残ります                                                           |
| イメージ                   | 全タスク共通。再ビルドすると各タスクに「イメージ更新あり」が出て、「作り直す」でボリュームを保ったまま載せ替えられます |
| アプリの設定・タスク一覧   | `%APPDATA%\cc-container-desktop\config.json` (環境もここ) / `tasks.json`。API キーは `secrets.json` (OS の暗号化ストア経由) |

タスクの削除はコンテナとボリュームを消します。「削除する前にワークスペースを取り出す」を付けると、取り出しに失敗した項目が 1 つでもあれば削除しません。

### v0.3 以前から

v0.3 の編集可能な Dockerfile・setup.sh・post-create.sh は扱いません (`%APPDATA%\cc-container-desktop\docker` に残ったままです)。setup.sh に書いていたものはベースイメージに含まれるか、環境のセットアップスクリプトへ移してください。v0.3 で作ったタスクには「環境更新あり」が出ます。「作り直す」で新しいベースイメージと環境に載せ替えてください。

## 開発

```
npm ci
npm run dev        # 開発モード
npm run check      # format / lint / typecheck / build
npm run e2e:deep   # Docker が必要 (API キー不要)。専用の userData と e2e- 接頭辞のタスクで動きます
npm run e2e        # Docker と CC_E2E_API_KEY が必要
```
