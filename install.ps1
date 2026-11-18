$ErrorActionPreference = "Stop"

$PackageName = "repo-harness"
$PackageVersion = if ($env:REPO_HARNESS_VERSION) { $env:REPO_HARNESS_VERSION } else { "latest" }
$MinimumBunVersion = [Version]"1.4.0"
# The Bun installer version whose writes were measured on Windows (#2853): a fresh Bun gets a bootstrap record only at this version.
$BunBootstrapVersion = "1.4.4"
$BunUninstallKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bun"
$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME ".bun" }
$BunBin = Join-Path $BunInstall "bin"
$BunBootstrapRecord = Join-Path $HOME ".repo-harness\bootstrap\bun.json"
$OriginalPath = $env:PATH

function Add-BunToPath {
  if (Test-Path $BunBin) {
    $env:PATH = "$BunBin$([System.IO.Path]::PathSeparator)$env:PATH"
  }
}

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# The user Path value as text, unexpanded, with its registry kind.
function Get-UserPath {
  $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
  try {
    $Existed = $Key.GetValueNames() -contains "Path"
    $Raw = if ($Existed) { [string]$Key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { "" }
    $Kind = if ($Existed) { $Key.GetValueKind("Path").ToString() } else { $null }
    return @{ Existed = $Existed; Raw = $Raw; Kind = $Kind }
  } finally { $Key.Close() }
}

# The record that the first rh install moves into the host-config ledger: the Bun path, version and sha256, the directory,
# the user Path entry and the registry key that the Bun installer created. rh never removes Bun.
function Write-BunBootstrapRecord($Before) {
  $Bun = Join-Path $BunBin "bun.exe"
  $Record = [ordered]@{
    installed_by = "rh-bootstrap"
    version = $BunBootstrapVersion
    path = $Bun
    sha256 = "sha256:" + (Get-FileHash -Algorithm SHA256 -LiteralPath $Bun).Hash.ToLower()
    directories = @(if ($Before.DirCreated) { $BunInstall })
  }
  $After = Get-UserPath
  if ($After.Raw -ne $Before.Path.Raw -or $After.Existed -ne $Before.Path.Existed) {
    $Inserted = if ($After.Raw.StartsWith($Before.Path.Raw, [StringComparison]::Ordinal)) { $After.Raw.Substring($Before.Path.Raw.Length) } else { "" }
    $Entry = $Inserted.TrimStart(";")
    if ($Entry -eq "" -or $Entry.Contains(";") -or ($Inserted -cne $Entry -and $Inserted -cne ";$Entry")) {
      throw "bun_bootstrap_path_changed: the Bun installer changed the user Path other than by one appended entry; no bootstrap record written"
    }
    $Record.path_entry = [ordered]@{ entry = $Entry; inserted = $Inserted; kind = $After.Kind; value_existed = $Before.Path.Existed }
  }
  if (-not $Before.KeyExisted -and (Test-Path "Registry::$BunUninstallKey")) { $Record.registry_keys = @($BunUninstallKey) }
  New-Item -ItemType Directory -Force -Path (Split-Path $BunBootstrapRecord) | Out-Null
  [System.IO.File]::WriteAllText($BunBootstrapRecord, ($Record | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
}

function Get-BunVersion {
  if (-not (Test-Command "bun")) {
    return $null
  }
  $RawVersion = (& bun --version 2>$null)
  if ($RawVersion -match '^(\d+)\.(\d+)\.(\d+)') {
    return [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  }
  return $null
}

if ($env:REPO_HARNESS_DRY_RUN -eq "1") {
  Write-Host "DRY RUN: would ensure Bun >= $MinimumBunVersion, install $PackageName@$PackageVersion, and verify rh --version."
  exit 0
}

Add-BunToPath

$BunVersion = Get-BunVersion
if ($null -eq $BunVersion -or $BunVersion -lt $MinimumBunVersion) {
  $BunAction = if ($null -eq $BunVersion) { "Installing" } else { "Upgrading" }
  # What the Bun installer can change, before it runs: the record of a fresh Bun names only what this run created.
  $BunBefore = @{ DirCreated = -not (Test-Path $BunInstall); Path = Get-UserPath; KeyExisted = Test-Path "Registry::$BunUninstallKey" }
  Write-Host "$BunAction Bun runtime $BunBootstrapVersion..."
  & ([scriptblock]::Create((Invoke-RestMethod https://bun.sh/install.ps1))) -Version $BunBootstrapVersion
  Add-BunToPath
  if ($BunAction -eq "Installing") {
    $InstalledBunVersion = Get-BunVersion
    if ($null -eq $InstalledBunVersion -or $InstalledBunVersion.ToString() -ne $BunBootstrapVersion) {
      throw "bun_bootstrap_version_mismatch: the Bun installer gave $InstalledBunVersion, and only $BunBootstrapVersion was measured; no bootstrap record written"
    }
    Write-BunBootstrapRecord $BunBefore
  }
}

$BunVersion = Get-BunVersion
if ($null -eq $BunVersion -or $BunVersion -lt $MinimumBunVersion) {
  $FoundBunVersion = if ($null -eq $BunVersion) { "unknown" } else { $BunVersion.ToString() }
  throw "Bun >= $MinimumBunVersion is required (found: $FoundBunVersion)."
}

$PackageSpec = "$PackageName@$PackageVersion"
Write-Host "Installing $PackageSpec with Bun..."
& bun add -g $PackageSpec

Add-BunToPath
if (-not (Test-Command "rh")) {
  throw "rh is not on PATH after installation."
}

$Version = (& rh --version)
if (-not $Version) {
  throw "rh installed, but version readback failed."
}

Write-Host "repo-harness $Version installed."
Write-Host ""
Write-Host "Next:"
Write-Host "  rh install"
Write-Host "  rh init --dry-run"

$PathSep = [System.IO.Path]::PathSeparator
if ("$PathSep$OriginalPath$PathSep" -notlike "*$PathSep$BunBin$PathSep*") {
  Write-Host ""
  Write-Host "To use rh in new shells, add to your PATH:"
  Write-Host "  $BunBin"
}
