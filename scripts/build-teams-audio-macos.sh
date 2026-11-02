#!/usr/bin/env bash
# Builds the Teams audio helper for macOS (native/teams-audio/macos, ScreenCaptureKit) for arm64 and x64, into
# native/teams-audio/dist/darwin-<arch>/teams-audio-helper, where electron-builder (build.mac.extraResources, per ${arch}) and
# development runs (main/teams-audio-helper.ts) find it. Fails if a binary was not built or is the wrong architecture.
# Needs Xcode (or the Command Line Tools) with the macOS 13 SDK or later; macos-latest has it.
# Usage: scripts/build-teams-audio-macos.sh [arm64] [x64]   (both by default)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source="$root/native/teams-audio/macos/main.swift"
arches=("$@")
if [ ${#arches[@]} -eq 0 ]; then arches=(arm64 x64); fi

for arch in "${arches[@]}"; do
  case "$arch" in
    arm64) swift_arch=arm64 ;;
    x64) swift_arch=x86_64 ;;
    *) echo "Unknown arch: $arch (arm64 or x64)" >&2; exit 2 ;;
  esac
  out="$root/native/teams-audio/dist/darwin-$arch"
  mkdir -p "$out"
  xcrun swiftc -O -swift-version 5 \
    -target "$swift_arch-apple-macos13.0" \
    -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics \
    -o "$out/teams-audio-helper" "$source"
  # Ad hoc signature so it runs on Apple silicon; electron-builder re-signs it with Bee's identity when one is set.
  codesign --force --sign - "$out/teams-audio-helper"
  test -f "$out/teams-audio-helper" || { echo "Teams audio helper missing: $out/teams-audio-helper" >&2; exit 1; }
  built="$(lipo -archs "$out/teams-audio-helper")"
  if [ "$built" != "$swift_arch" ]; then echo "Teams audio helper is $built, expected $swift_arch" >&2; exit 1; fi
  echo "Built $out/teams-audio-helper ($swift_arch, $(stat -f %z "$out/teams-audio-helper") bytes)"
done

# --version prints and exits at once: it never opens audio, so it cannot hang. Only the host's own arch can run here.
host="$(uname -m)"
host_arch="$([ "$host" = "arm64" ] && echo arm64 || echo x64)"
if [ -x "$root/native/teams-audio/dist/darwin-$host_arch/teams-audio-helper" ]; then
  version="$("$root/native/teams-audio/dist/darwin-$host_arch/teams-audio-helper" --version)"
  if [ "$version" != "teams-audio-helper protocol=1" ]; then echo "Teams audio helper --version failed: $version" >&2; exit 1; fi
  echo "$version"
fi
