<div align="center">

# repo-harness

### 把 GitHub issue 交给 AI agent，拿回一个真正能 review 的 PR

[![npm version](https://img.shields.io/npm/v/repo-harness.svg)](https://www.npmjs.com/package/repo-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.0-black.svg)](https://bun.sh)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20%C2%B7%20Codex%20%C2%B7%20Pi-6b4fbb.svg)](README.md#supported-hosts)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md) | [Türkçe](README.tr.md)

</div>

`repo-harness` 是一套 CLI、hooks 和 skills，包在现有仓库外层，让 **Claude、Codex 和 Pi** 跨会话、跨机器、跨 worktree 执行长周期工程任务，并留下几分钟就能 review 的证据。GitHub issue 和 PR 管理任务范围、状态和验收，人只做一件事：**决定是否接受变更。**

## 安装

前置条件：一个 Git working tree、[Bun](https://bun.sh) ≥ 1.4.0（安装脚本会自动安装或升级），以及用于宿主就绪检查的 [`hc`](https://herdr.dev/)（herdr-core）。macOS/Linux 需要 `bash`；Windows 需要 Git for Windows；不需要 Node.js。完整说明见 [README.md](README.md#quick-start)。

```bash
# 1. Install the CLI and user-level hook adapters
curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex
```

已有 Bun？直接运行 `bunx -p repo-harness@latest rh install`。

## 第一条命令

在目标仓库根目录先预览，再应用：

```bash
# 2. From the root of the repository you want to adopt: preview, then apply
rh init --dry-run   # reports every file it would write; writes nothing
rh init
```

完成后会输出 `=== Migration Report ===` 变更摘要和 `--- External Tooling ---` 就绪检查。接着在仓库里打开 Claude、Codex 或 Pi，交给它一个 issue，hooks 会接管上下文与安全边界。

## 完整文档

本页是简要入口。英文 [README.md](README.md) 涵盖工作原理、设计原则、命令速查、Operator console、Skills 与支持宿主；安装细节、升级清理、验收 review、hooks、MCP 与维护者参考见 [使用指南](docs/usage.md)，变更记录见 [Changelog](docs/CHANGELOG.md)。

## 许可证

MIT — 见 [`LICENSE`](LICENSE)
