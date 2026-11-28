<div align="center">

# repo-harness

### AI エージェントに GitHub issue を渡す。実際にレビューできる PR が返ってくる。

[![npm version](https://img.shields.io/npm/v/repo-harness.svg)](https://www.npmjs.com/package/repo-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.0-black.svg)](https://bun.sh)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20%C2%B7%20Codex%20%C2%B7%20Pi-6b4fbb.svg)](README.md#supported-hosts)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md) | [Türkçe](README.tr.md)

</div>

`repo-harness` は既存リポジトリを包み込む CLI、hooks、skills のセットです。**Claude、Codex、Pi** がセッション、マシン、worktree をまたいで長期のエンジニアリング作業を進め、人間が数分でレビューできる証跡を PR に残せます。GitHub issue と PR がタスクの正本を持ち、人間は変更を受け入れるかどうかの判断に集中できます。

## インストール

前提条件: Git 作業ツリー、[Bun](https://bun.sh) ≥ 1.4.0（インストーラーが導入・更新します）、[`hc`](https://herdr.dev/)（herdr-core）。macOS/Linux は `bash`、Windows は Git for Windows が必要です。Node.js は不要です。詳細は [README.md](README.md#quick-start) を参照してください。

```bash
# 1. Install the CLI and user-level hook adapters
curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex
```

すでに Bun がある場合は `bunx -p repo-harness@latest rh install` を使えます。

## 最初のコマンド

対象リポジトリのルートでプレビューし、次に適用します。

```bash
# 2. From the root of the repository you want to adopt: preview, then apply
rh init --dry-run   # reports every file it would write; writes nothing
rh init
```

初期化の最後に `=== Migration Report ===` と `--- External Tooling ---` が表示されます。ヘルパースクリプトはリポジトリにコピーせず、`rh run <helper>` で呼び出します。

## ドキュメント

このページは概要です。仕組み、設計原則、コマンド一覧、オペレーターコンソール、skills、対応ホストの全文は英語の [README.md](README.md) を参照してください。

- 導入詳細、アップグレード、アンインストール、hooks、MCP、メンテナー向け情報: [利用ガイド](docs/usage.md)
- リリース履歴: [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## ライセンス

MIT — [`LICENSE`](LICENSE) を参照してください。
