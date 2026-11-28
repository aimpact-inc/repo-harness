<div align="center">

# repo-harness

### Yapay zekâ ajanına bir GitHub issue verin. Gerçekten inceleyebileceğiniz bir PR alın.

[![npm version](https://img.shields.io/npm/v/repo-harness.svg)](https://www.npmjs.com/package/repo-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.0-black.svg)](https://bun.sh)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20%C2%B7%20Codex%20%C2%B7%20Pi-6b4fbb.svg)](README.md#supported-hosts)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md) | [Türkçe](README.tr.md)

</div>

`repo-harness`, mevcut bir depoyu sarmalayan bir CLI, hook seti ve skill setidir. **Claude, Codex ve Pi** ajanlarının oturumlar, makineler ve worktree'ler boyunca uzun soluklu mühendislik işleri yürütmesini ve dakikalar içinde incelenebilir kanıt bırakmasını sağlar. Görev kapsamı, durum ve kabul kayıtları GitHub issue ile PR üzerinde tutulur; insana tek bir iş kalır: **değişikliği kabul edip etmemeye karar vermek.**

## Kurulum

**Ön koşullar:** bir Git çalışma ağacı, [Bun](https://bun.sh) ≥ 1.4.0 (kurulum betiği sizin yerinize kurar veya günceller) ve host hazırlığı için [`hc`](https://herdr.dev/) (herdr-core). macOS/Linux için `bash`, Windows için Git for Windows gerekir. Node.js gerekmez. Ayrıntılar için [README.md](README.md#quick-start) dosyasına bakın.

```bash
# 1. Install the CLI and user-level hook adapters
curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex
```

Bun zaten kuruluysa bunun yerine `bunx -p repo-harness@latest rh install` komutunu çalıştırın.

## İlk komut

Hedef deponun kök dizininde önce önizleyin, sonra uygulayın:

```bash
# 2. From the root of the repository you want to adopt: preview, then apply
rh init --dry-run   # reports every file it would write; writes nothing
rh init
```

`rh init` tamamlandığında oluşturulan veya güncellenen dosyaları gösteren `=== Migration Report ===` çıktısı ile `--- External Tooling ---` hazırlık özetini yazar. Ardından depoda Claude, Codex veya Pi açıp bir issue vermeniz yeterlidir; bağlam ve düzenleme sınırlarını hook'lar devralır.

## Tam dokümantasyon

Bu sayfa kısa bir özet girişidir. Çalışma mantığı, tasarım ilkeleri, komut özeti, Operator console, skill'ler ve desteklenen host'lar İngilizce [README.md](README.md) dosyasındadır. Ayrıntılı kurulum, güncelleme, kabul incelemesi, hook'lar, MCP ve geliştirici başvurusu için [kullanım kılavuzuna](docs/usage.md), sürüm geçmişi için [Changelog](docs/CHANGELOG.md) dosyasına bakın.

## Lisans

MIT — bkz. [`LICENSE`](LICENSE)
