# Builds the Teams audio helper for Windows (native/teams-audio/windows, WASAPI process loopback) with the Visual Studio
# toolchain through CMake, into native/teams-audio/dist/win32-x64/teams-audio-helper.exe, where electron-builder
# (build.win.extraResources) and development runs (main/teams-audio-helper.ts) find it. Fails if the exe was not built or
# does not answer --version. Needs Visual Studio 2022 (or Build Tools) with the C++ workload and CMake; windows-latest has both.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "native/teams-audio/windows"
$build = Join-Path $root "native/teams-audio/build/win32-x64"
$dist = Join-Path $root "native/teams-audio/dist/win32-x64"
$exe = Join-Path $dist "teams-audio-helper.exe"

cmake -S $source -B $build -A x64
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }
cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw "CMake build failed ($LASTEXITCODE)" }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item -Force (Join-Path $build "Release/teams-audio-helper.exe") $exe
if (-not (Test-Path $exe)) { throw "Teams audio helper missing: $exe" }

# --version prints and exits at once: it never opens audio, so it cannot hang.
$version = & $exe --version
if ($LASTEXITCODE -ne 0 -or "$version" -notmatch "^teams-audio-helper protocol=1$") { throw "Teams audio helper --version failed: $version" }
Write-Host "Built $exe ($((Get-Item $exe).Length) bytes): $version"
