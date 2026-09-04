[CmdletBinding()]
param()

# Staging artifact for the unreleased 0.1.2 package set. Do not copy this file
# to a public route until tinyedge@0.1.2 and its exact dependencies are
# published, provenance-checked, and installed successfully on clean Windows
# x64 and arm64 environments.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TinyEdgeVersion = '0.1.2'
$MinimumNodeVersion = [Version]'22.19.0'
$NodeVersion = '24.5.0'
$NodeArchiveHashes = @{
  'x64' = 'c6a5714108caa81bc71e3859c18f449a8f456e275946c0d429e2d7120b03d20e'
  'arm64' = 'fd97842c3639fbc33ef9fc8c0c6adc5d45e56662a4354c7213c58a55a0432e8e'
}

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "[TinyEdge] $Message" -ForegroundColor Cyan
}

function Test-CompatibleNode {
  param(
    [string]$NodePath,
    [string]$Architecture
  )

  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    return $false
  }

  try {
    $rawVersion = (& $NodePath --version 2>$null | Select-Object -First 1)
    if (-not $rawVersion) { return $false }
    $parsedVersion = [Version]($rawVersion.Trim().TrimStart('v'))
    if ($parsedVersion -lt $MinimumNodeVersion) { return $false }

    if ($Architecture) {
      $rawArchitecture = (& $NodePath -p 'process.arch' 2>$null | Select-Object -First 1)
      if (-not $rawArchitecture -or $rawArchitecture.Trim() -ne $Architecture) {
        return $false
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Resolve-Architecture {
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }

  switch ($architecture.ToUpperInvariant()) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { throw "TinyEdge supports Windows x64 and arm64. Detected architecture: $architecture" }
  }
}

function Install-PinnedNode {
  param(
    [Parameter(Mandatory = $true)][string]$TinyEdgeHome,
    [Parameter(Mandatory = $true)][string]$Architecture
  )

  $archiveName = "node-v$NodeVersion-win-$Architecture.zip"
  $runtimeRoot = Join-Path $TinyEdgeHome 'runtime'
  $nodeHome = Join-Path $runtimeRoot "node-v$NodeVersion-win-$Architecture"
  $nodePath = Join-Path $nodeHome 'node.exe'

  if (Test-CompatibleNode -NodePath $nodePath -Architecture $Architecture) {
    Write-Step "Using the verified TinyEdge Node.js runtime at $nodeHome"
    return $nodeHome
  }

  if (Test-Path -LiteralPath $nodeHome) {
    throw "The managed runtime exists but is incomplete: $nodeHome. Rename it and run the installer again."
  }

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $downloadPath = Join-Path ([IO.Path]::GetTempPath()) "$([Guid]::NewGuid().ToString('N'))-$archiveName"
  $stagingRoot = Join-Path $runtimeRoot "staging-$([Guid]::NewGuid().ToString('N'))"

  try {
    Write-Step "Downloading pinned Node.js v$NodeVersion from nodejs.org"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$archiveName" -OutFile $downloadPath

    $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = $NodeArchiveHashes[$Architecture]
    if ($actualHash -ne $expectedHash) {
      throw "Node.js archive checksum mismatch. Expected $expectedHash but received $actualHash."
    }

    Write-Step 'Node.js checksum verified'
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    Expand-Archive -LiteralPath $downloadPath -DestinationPath $stagingRoot
    $expandedHome = Join-Path $stagingRoot "node-v$NodeVersion-win-$Architecture"
    if (-not (Test-CompatibleNode -NodePath (Join-Path $expandedHome 'node.exe') -Architecture $Architecture)) {
      throw 'The verified Node.js archive did not contain a usable runtime.'
    }
    Move-Item -LiteralPath $expandedHome -Destination $nodeHome
  } finally {
    if (Test-Path -LiteralPath $downloadPath) {
      Remove-Item -LiteralPath $downloadPath -Force
    }
    if (Test-Path -LiteralPath $stagingRoot) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
  }

  return $nodeHome
}

if ($env:OS -ne 'Windows_NT') {
  throw 'This historical unreleased-source installer is Windows-only. On qualified Ubuntu desktop x64, first require `npm view physicalsystems@0.2.2 version --json` to return `"0.2.2"`, then run `npx --yes physicalsystems@0.2.2`.'
}

if (-not $env:LOCALAPPDATA) {
  throw 'LOCALAPPDATA is unavailable; TinyEdge cannot create its per-user installation.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tinyEdgeHome = Join-Path $env:LOCALAPPDATA 'TinyEdge'
$packagePrefix = Join-Path $tinyEdgeHome 'npm'
$architecture = Resolve-Architecture
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmPath = if ($npmCommand) { $npmCommand.Source } else { $null }

if (-not (Test-CompatibleNode -NodePath $nodePath -Architecture $architecture) -or -not $npmPath) {
  $nodeHome = Install-PinnedNode -TinyEdgeHome $tinyEdgeHome -Architecture $architecture
  $nodePath = Join-Path $nodeHome 'node.exe'
  $npmPath = Join-Path $nodeHome 'npm.cmd'
} else {
  Write-Step "Using $(& $nodePath --version) from $nodePath"
}

New-Item -ItemType Directory -Path $packagePrefix -Force | Out-Null
Write-Step "Installing tinyedge@$TinyEdgeVersion from the npm registry"
& $npmPath install --global --prefix $packagePrefix "tinyedge@$TinyEdgeVersion" --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  throw "npm could not install tinyedge@$TinyEdgeVersion (exit code $LASTEXITCODE)."
}

$tinyEdgeEntry = Join-Path $packagePrefix 'node_modules\tinyedge\bin\tinyedge.js'
if (-not (Test-Path -LiteralPath $tinyEdgeEntry -PathType Leaf)) {
  throw "The npm package did not contain the expected TinyEdge entry point: $tinyEdgeEntry"
}

$shimPath = Join-Path $packagePrefix 'tinyedge.cmd'
$portableHome = '%LOCALAPPDATA%\TinyEdge'
$homePrefix = $tinyEdgeHome.TrimEnd('\')
$entryForShim = "$portableHome$($tinyEdgeEntry.Substring($homePrefix.Length))"
$nodeForShim = if ($nodePath.StartsWith($homePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  "`"$portableHome$($nodePath.Substring($homePrefix.Length))`""
} else {
  'node.exe'
}
$shim = "@echo off`r`n$nodeForShim `"$entryForShim`" %*`r`n"
[IO.File]::WriteAllText($shimPath, $shim, [Text.Encoding]::ASCII)

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathParts = @()
if ($userPath) {
  $pathParts = @($userPath.Split(';') | Where-Object { $_ })
}
$alreadyOnPath = $pathParts | Where-Object { $_.TrimEnd('\') -ieq $packagePrefix.TrimEnd('\') }
if (-not $alreadyOnPath) {
  $updatedUserPath = if ($userPath) { "$packagePrefix;$userPath" } else { $packagePrefix }
  [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
}
$env:Path = "$packagePrefix;$env:Path"

$installedVersion = (& $shimPath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $installedVersion -notmatch [Regex]::Escape($TinyEdgeVersion)) {
  throw "TinyEdge installed but failed its version check. Output: $installedVersion"
}

Write-Step "Installed $installedVersion"
Write-Host ''
Write-Host 'Open a new terminal and run:' -ForegroundColor Green
Write-Host '  tinyedge' -ForegroundColor White
