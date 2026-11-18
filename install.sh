#!/usr/bin/env sh
set -eu

ORIGINAL_PATH="${PATH:-}"

PACKAGE_NAME="repo-harness"
PACKAGE_VERSION="${REPO_HARNESS_VERSION:-latest}"
MIN_BUN_VERSION="1.4.0"
# The Bun installer version whose writes were measured (#2853): a fresh Bun gets a bootstrap record only at this version.
BUN_BOOTSTRAP_VERSION="1.4.4"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'rh install: %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || die "HOME is not set"
BUN_INSTALL_DIR="${BUN_INSTALL:-$HOME_DIR/.bun}"
BUN_BOOTSTRAP_RECORD="$HOME_DIR/.repo-harness/bootstrap/bun.json"

bun_version_at_least() {
  current_version="${1:-}"
  awk -v current="$current_version" -v minimum="$MIN_BUN_VERSION" 'BEGIN {
    current_count = split(current, current_parts, /[.-]/)
    minimum_count = split(minimum, minimum_parts, /[.-]/)
    if (current_count < 3 || minimum_count < 3) exit 1
    for (i = 1; i <= 3; i++) {
      if (current_parts[i] !~ /^[0-9]+$/ || minimum_parts[i] !~ /^[0-9]+$/) exit 1
      if ((current_parts[i] + 0) > (minimum_parts[i] + 0)) exit 0
      if ((current_parts[i] + 0) < (minimum_parts[i] + 0)) exit 1
    }
    exit 0
  }'
}

install_bun() {
  if has_command bun; then
    current_bun_version="$(bun --version 2>/dev/null || true)"
    if bun_version_at_least "$current_bun_version"; then
      return 0
    fi
    bun_action="Upgrading"
  else
    bun_action="Installing"
  fi

  has_command bash || die "bash is required to install Bun automatically"

  # What the Bun installer can change, before it runs: the bootstrap record of a fresh Bun names only what this run created.
  bun_dir_created=0
  [ -e "$BUN_INSTALL_DIR" ] || bun_dir_created=1
  zshrc_before=""
  if [ "$bun_action" = "Installing" ] && [ -f "$HOME_DIR/.zshrc" ]; then
    zshrc_before="$(mktemp)"
    cp "$HOME_DIR/.zshrc" "$zshrc_before"
  fi

  if has_command curl; then
    log "${bun_action} Bun runtime ${BUN_BOOTSTRAP_VERSION}..."
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_BOOTSTRAP_VERSION}"
  elif has_command wget; then
    log "${bun_action} Bun runtime ${BUN_BOOTSTRAP_VERSION}..."
    wget -qO- https://bun.sh/install | bash -s "bun-v${BUN_BOOTSTRAP_VERSION}"
  else
    die "curl or wget is required to install Bun automatically"
  fi

  export PATH="$BUN_INSTALL_DIR/bin:$PATH"
  has_command bun || die "Bun install completed, but bun is still not on PATH"
  current_bun_version="$(bun --version 2>/dev/null || true)"
  bun_version_at_least "$current_bun_version" || die "Bun >= ${MIN_BUN_VERSION} is required (found: ${current_bun_version:-unknown})"
  if [ "$bun_action" = "Installing" ]; then
    [ "$current_bun_version" = "$BUN_BOOTSTRAP_VERSION" ] || die "bun_bootstrap_version_mismatch: the Bun installer gave ${current_bun_version:-unknown}, and only ${BUN_BOOTSTRAP_VERSION} was measured; no bootstrap record written"
    write_bun_bootstrap_record
  fi
  [ -z "$zshrc_before" ] || rm -f "$zshrc_before"
}

# The record that the first rh install moves into the host-config ledger: the Bun path, version and sha256, the directory that
# the installer created, and the text that it appended to ~/.zshrc. Bun computes it, so the JSON escapes every byte.
write_bun_bootstrap_record() {
  (
    umask 077
    mkdir -p "$(dirname "$BUN_BOOTSTRAP_RECORD")"
    RH_RECORD="$BUN_BOOTSTRAP_RECORD" RH_BUN="$BUN_INSTALL_DIR/bin/bun" RH_BUN_VERSION="$current_bun_version" \
    RH_BUN_DIR="$BUN_INSTALL_DIR" RH_BUN_DIR_CREATED="$bun_dir_created" RH_ZSHRC="$HOME_DIR/.zshrc" RH_ZSHRC_BEFORE="$zshrc_before" \
    bun -e '
      const env = process.env;
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await Bun.file(env.RH_BUN).arrayBuffer());
      const record = { installed_by: "rh-bootstrap", version: env.RH_BUN_VERSION, path: env.RH_BUN, sha256: "sha256:" + hasher.digest("hex"),
        directories: env.RH_BUN_DIR_CREATED === "1" ? [env.RH_BUN_DIR] : [] };
      const after = await Bun.file(env.RH_ZSHRC).exists() ? await Bun.file(env.RH_ZSHRC).text() : "";
      const before = env.RH_ZSHRC_BEFORE ? await Bun.file(env.RH_ZSHRC_BEFORE).text() : "";
      if (!after.startsWith(before)) { console.error("bun_bootstrap_profile_changed: the Bun installer changed ~/.zshrc other than by an append; no bootstrap record written"); process.exit(1); }
      if (after.length > before.length) record.profile = { file: env.RH_ZSHRC, inserted: after.slice(before.length) };
      await Bun.write(env.RH_RECORD, JSON.stringify(record, null, 2) + "\n");
    '
  ) || die "the Bun bootstrap record was not written"
}

install_repo_harness() {
  package_spec="${PACKAGE_NAME}@${PACKAGE_VERSION}"
  log "Installing ${package_spec} with Bun..."
  bun add -g "$package_spec"
}

verify_repo_harness() {
  export PATH="$BUN_INSTALL_DIR/bin:$PATH"
  has_command rh || die "rh is not on PATH after installation"
  version="$(rh --version 2>/dev/null || true)"
  [ -n "$version" ] || die "rh installed, but version readback failed"
  log "repo-harness ${version} installed."
}


cat <<'BANNER'

           _____________
          /             |
     /\  /|            \|/
    /  \/ |             V
   ( o    \            / \
    \   __/           /___\
    /  /
   /  /____
  /        \        repo-harness
 /|        |        installer
  | |  | | |        repoharness.com
  |_|  |_|_|

BANNER

if [ "${REPO_HARNESS_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: would ensure Bun >= ${MIN_BUN_VERSION}, install ${PACKAGE_NAME}@${PACKAGE_VERSION}, and verify rh --version."
  exit 0
fi

install_bun
install_repo_harness
verify_repo_harness

log ""
log "Next:"
log "  rh install"
log "  rh init --dry-run"

case ":$ORIGINAL_PATH:" in
  *":$BUN_INSTALL_DIR/bin:"*) ;;
  *)
    log ""
    log "To use rh in new shells, add to your shell profile:"
    log "  export PATH=\"$BUN_INSTALL_DIR/bin:\$PATH\""
    ;;
esac
