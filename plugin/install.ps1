# Install dsh-plugin-xefg-think into the DSH web profile that is actually running.
#
#   & .\install.ps1                 # bundle mode: listed in Settings > Plugins as an installed bundle
#   & .\install.ps1 -LegacyInsert   # fallback: plain patch insert (works even if bundle composition fails)
#   & .\install.ps1 -Uninstall      # remove every hook; installed files are left in place
#
# The desktop app keeps its profile under %APPDATA%\DSH Desktop\profiles\web;
# a CLI install keeps it under ~/.dsh\profiles\web. Auto-detection prefers the
# desktop profile because that is the one the running GUI reads.
#
# Exactly ONE loading mechanism is active at a time: a bundle row and a patch
# insert that both insert `id: xefg-think` would collide.
param(
  [string]$ProfileDir,
  [switch]$Uninstall,
  [switch]$LegacyInsert
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$pkgName = 'dsh-plugin-xefg-think'

function Resolve-Profile([string]$explicit) {
  if ($explicit) {
    if (-not (Test-Path (Join-Path $explicit 'cordis.patch.yml'))) {
      throw "No cordis.patch.yml in $explicit"
    }
    return (Resolve-Path $explicit).Path
  }
  foreach ($c in @(
    (Join-Path $env:APPDATA 'DSH Desktop\profiles\web'),
    (Join-Path $env:USERPROFILE '.dsh\profiles\web')
  )) {
    if (Test-Path (Join-Path $c 'cordis.patch.yml')) { return (Resolve-Path $c).Path }
  }
  throw 'No DSH web profile found. Start the app once, then re-run.'
}

function Read-Text([string]$path) {
  if (-not (Test-Path $path)) { return '' }
  return [System.IO.File]::ReadAllText($path)
}

function Write-Text([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Get-ProfileManifest([string]$path) {
  $raw = Read-Text $path
  if (-not $raw) { throw "Missing profile manifest: $path" }
  return $raw | ConvertFrom-Json
}

function Save-ProfileManifest([string]$path, $manifest) {
  $json = $manifest | ConvertTo-Json -Depth 20
  # Validate before writing: a malformed manifest stops the app from booting.
  $null = $json | ConvertFrom-Json
  Copy-Item $path "$path.bak-xefg" -Force
  Write-Text $path $json
}

$profileDir = Resolve-Profile $ProfileDir
$modules = Join-Path $profileDir 'node_modules'
$target = Join-Path $modules $pkgName
$vendor = Join-Path $profileDir "vendor\$pkgName"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$manifestFile = Join-Path $profileDir 'package.json'

Write-Host "Profile    -> $profileDir"

# --- shared: copy the package ------------------------------------------------
function Install-Files([string]$dest) {
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item (Join-Path $src 'package.json') $dest
  Copy-Item (Join-Path $src 'cordis.patch.yml') $dest
  Copy-Item (Join-Path $src 'lib') (Join-Path $dest 'lib') -Recurse
  if (Test-Path (Join-Path $src 'README.md')) { Copy-Item (Join-Path $src 'README.md') $dest }
  Write-Host "Files      -> $dest"
}

# --- shared: patch-file insert ----------------------------------------------
$insertBlock = "- insert:`n    - id: xefg-think`n      name: '$pkgName'`n"

function Set-PatchInsert([bool]$present) {
  $doc = Read-Text $patchFile
  $hasIt = $doc -match [regex]::Escape($pkgName)
  if ($present -and -not $hasIt) {
    if (-not $doc.EndsWith("`n")) { $doc += "`n" }
    Write-Text $patchFile ($doc + $insertBlock)
    Write-Host "Patch      -> inserted into cordis.patch.yml"
  } elseif (-not $present -and $hasIt) {
    $doc = [regex]::Replace($doc, "(?m)^- insert:\s*\r?\n\s*- id: xefg-think\s*\r?\n\s*name: '?dsh-plugin-xefg-think'?\s*\r?\n?", '')
    Write-Text $patchFile $doc
    Write-Host "Patch      -> removed from cordis.patch.yml"
  }
}

# --- shared: profile manifest bookkeeping -----------------------------------
function Set-BundleRegistration([bool]$present) {
  $manifest = Get-ProfileManifest $manifestFile
  $changed = $false

  $bundles = @()
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
  }
  $has = $bundles -contains $pkgName

  if ($present -and -not $has) {
    $bundles = $bundles + $pkgName
    $changed = $true
  } elseif (-not $present -and $has) {
    $bundles = @($bundles | Where-Object { $_ -ne $pkgName })
    $changed = $true
  }

  $deps = $manifest.dependencies
  $depSpec = 'file:./vendor/' + $pkgName
  $hasDep = $false
  if ($deps) { $hasDep = $deps.PSObject.Properties.Name -contains $pkgName }
  if ($present -and -not $hasDep) { $changed = $true }
  if (-not $present -and $hasDep) { $changed = $true }

  if (-not $changed) {
    Write-Host 'Bundles    -> already in the desired state'
    return
  }

  if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $manifest.dsh.profile) {
    $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

  if (-not $manifest.dependencies) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if ($present) {
    $manifest.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $depSpec -Force
  } elseif ($hasDep) {
    $manifest.dependencies.PSObject.Properties.Remove($pkgName)
  }

  Save-ProfileManifest $manifestFile $manifest
  if ($present) { Write-Host 'Bundles    -> registered as a profile bundle (Settings > Plugins lists it)' }
  else { Write-Host 'Bundles    -> unregistered' }
}

# --- modes ------------------------------------------------------------------
if ($Uninstall) {
  Set-PatchInsert $false
  Set-BundleRegistration $false
  Write-Host ''
  Write-Host 'Removed every hook. The package files are still in place; restart DSH Desktop to unload.'
  exit 0
}

if ($LegacyInsert) {
  Install-Files $target
  Set-BundleRegistration $false
  Set-PatchInsert $true
  Write-Host ''
  Write-Host 'Legacy mode: loaded by a plain patch insert. Works, but the settings page will not list it.'
} else {
  Install-Files $target
  # A bundle resolves its own package by name from the profile, so keep a copy
  # next to the manifest as the declared file: target.
  $vendorRoot = Split-Path $vendor -Parent
  if (-not (Test-Path $vendorRoot)) { New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null }
  Install-Files $vendor
  Set-BundleRegistration $true
  Set-PatchInsert $false
  Write-Host ''
  Write-Host 'Bundle mode: registered in dsh.profile.bundles, so Settings > Plugins should list it.'
}

Write-Host ''
Write-Host 'Restart DSH Desktop once. Then:'
Write-Host '  * the XeFG pill sits in the composer row (the landing page too, not only inside a session)'
Write-Host '  * Settings > Plugins > installed bundles should list dsh-plugin-xefg-think with a switch'
Write-Host 'If it shows a problem badge and the pill is missing, fall back with:  & .\install.ps1 -LegacyInsert'
