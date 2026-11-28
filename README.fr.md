<div align="center">

# repo-harness

### Confiez une issue GitHub à un agent IA. Recevez une PR vraiment prête pour la revue.

[![npm version](https://img.shields.io/npm/v/repo-harness.svg)](https://www.npmjs.com/package/repo-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.0-black.svg)](https://bun.sh)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20%C2%B7%20Codex%20%C2%B7%20Pi-6b4fbb.svg)](README.md#supported-hosts)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md) | [Türkçe](README.tr.md)

</div>

`repo-harness` est un CLI accompagné de hooks et de skills qui encadre un dépôt existant. Il permet à **Claude, Codex et Pi** de mener des tâches d'ingénierie sur la durée — à travers sessions, machines et worktrees — en laissant des preuves relisibles en quelques minutes. L'issue et la PR GitHub portent la tâche ; l'humain se concentre sur la décision d'accepter ou non le changement.

## Installation

Prérequis : un working tree Git, [Bun](https://bun.sh) ≥ 1.4.0 (installé ou mis à jour par l'installeur) et [`hc`](https://herdr.dev/) (herdr-core). `bash` est requis sur macOS/Linux et Git for Windows sur Windows. Node.js n'est pas nécessaire. Détails dans [README.md](README.md#quick-start).

```bash
# 1. Install the CLI and user-level hook adapters
curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex
```

Vous avez déjà Bun ? Lancez `bunx -p repo-harness@latest rh install`.

## Premières commandes

À la racine du dépôt cible, prévisualisez puis appliquez :

```bash
# 2. From the root of the repository you want to adopt: preview, then apply
rh init --dry-run   # reports every file it would write; writes nothing
rh init
```

L'initialisation affiche `=== Migration Report ===` et `--- External Tooling ---`. Aucun script auxiliaire n'est copié dans le dépôt : appelez `rh run <helper>`.

## Documentation

Cette page est un résumé. La documentation complète — fonctionnement, principes de conception, commandes, console opérateur, skills et hôtes pris en charge — se trouve dans [README.md](README.md).

- Installation détaillée, mise à jour, désinstallation, hooks, MCP et guide mainteneur : [guide d'utilisation](docs/usage.md)
- Historique des versions : [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## Licence

MIT — voir [`LICENSE`](LICENSE).
