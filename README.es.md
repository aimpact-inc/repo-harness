<div align="center">

# repo-harness

### Entrega una issue de GitHub a un agente de IA. Recibe una PR que puedas revisar de verdad.

[![npm version](https://img.shields.io/npm/v/repo-harness.svg)](https://www.npmjs.com/package/repo-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.0-black.svg)](https://bun.sh)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20%C2%B7%20Codex%20%C2%B7%20Pi-6b4fbb.svg)](README.md#supported-hosts)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md) | [Türkçe](README.tr.md)

</div>

`repo-harness` es un CLI con hooks y skills que envuelve un repositorio existente para que **Claude, Codex y Pi** hagan trabajo de ingeniería continuo entre sesiones, máquinas y worktrees, dejando evidencia revisable en minutos. La issue y la PR de GitHub son dueñas de la tarea; la persona solo decide si aceptar el cambio.

## Instalación

Requisitos: un árbol de trabajo de Git, [Bun](https://bun.sh) ≥ 1.4.0 (el instalador lo instala o actualiza) y [`hc`](https://herdr.dev/) (herdr-core). Requiere `bash` en macOS/Linux y Git for Windows en Windows. No necesita Node.js. Detalles en [README.md](README.md#quick-start).

```bash
# 1. Install the CLI and user-level hook adapters
curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex
```

¿Ya tienes Bun? Ejecuta `bunx -p repo-harness@latest rh install`.

## Primeros comandos

En la raíz del repositorio de destino, primero previsualiza y luego aplica:

```bash
# 2. From the root of the repository you want to adopt: preview, then apply
rh init --dry-run   # reports every file it would write; writes nothing
rh init
```

Al terminar muestra `=== Migration Report ===` y `--- External Tooling ---`. No se copian scripts auxiliares en el repositorio: ejecuta `rh run <helper>`.

## Documentación

Esta página es un resumen. La guía completa —cómo funciona, principios de diseño, comandos, consola de operador, skills y hosts compatibles— está en [README.md](README.md).

- Instalación detallada, actualización, desinstalación, hooks, MCP y referencia para mantenedores: [guía de uso](docs/usage.md)
- Historial de versiones: [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## Licencia

MIT — consulta [`LICENSE`](LICENSE).
