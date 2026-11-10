# Call audio helpers

Small native programs that let Bee hear **one call app alone** during a call (Live → Meeting → **Hear other people in
calls**): the Teams desktop app by default, or the app Bee names — Zoom, or the browser that runs a Google Meet call. They
accept call apps only (an allowlist below), never capture all system audio, the screen or any other app, and do not start if
they cannot limit themselves to the target. The folder and binary keep their old `teams-audio` names.

| | Windows | macOS |
| --- | --- | --- |
| Source | `windows/teams-audio-helper.cpp` (C++17, Win32 and COM only) | `macos/main.swift` (Swift 5, Apple frameworks only) |
| How | WASAPI process loopback: `ActivateAudioInterfaceAsync` on `VAD\Process_Loopback` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` | ScreenCaptureKit: an `SCContentFilter` that includes only the target apps, `capturesAudio`, 2 × 2 px video at 1 frame a second that is dropped unread |
| Default target | `ms-teams.exe` (new Teams), `Teams.exe` (classic), and the process tree under the top one | `com.microsoft.teams2` (new Teams), `com.microsoft.teams` (classic), and their helper apps (`<id>.…`) |
| Allowed targets | `--image`: `ms-teams.exe`, `teams.exe`, `zoom.exe`, `chrome.exe`, `msedge.exe`, `brave.exe`, `arc.exe`, `firefox.exe`, `vivaldi.exe`, `opera.exe` | `--bundle-id`: the Teams ids, `us.zoom.xos`, `com.google.chrome`, `org.chromium.chromium`, `com.microsoft.edgemac`, `com.brave.browser`, `company.thebrowser.browser`, `org.mozilla.firefox`, `com.vivaldi.vivaldi`, `com.operasoftware.opera` (and their `<id>.…` helper apps). Not Safari: WebKit plays sound from shared system processes |
| Never | Starts or keeps running if the target's process tree holds anything but the target (images that start with its name), its known helpers (Zoom: `CptHost`, `zWebview2Agent`, `aomhost`, …; Edge: `identity_helper`, …; Firefox: `crashreporter`, …), WebView2 (`msedgewebview2.exe`) and crash or console helpers | Includes Bee (`app.bee.desktop`) or any app that is not the target |
| A browser | The whole browser: every tab of that browser is heard, not only the Meet tab | The same: every tab of that browser |
| OS floor | Windows 10 build 19041 (version 2004). Microsoft documents process loopback from build 20348; it is used from 19041 elsewhere (GStreamer). Below a build that supports it, activation fails and the helper reports `unsupported` | macOS 13 (ScreenCaptureKit audio) |
| Permission | None | Screen Recording for Bee ("Screen & System Audio Recording" on macOS 15). The helper never prompts unless run with `--request-permission` |
| Build | `npm run build:teams-audio:win` (`scripts/build-teams-audio-windows.ps1`: CMake and Visual Studio 2022 C++) | `npm run build:teams-audio:mac` (`scripts/build-teams-audio-macos.sh`: `xcrun swiftc` for arm64 and x64, ad hoc signed) |
| Output | `dist/win32-x64/teams-audio-helper.exe` | `dist/darwin-arm64/teams-audio-helper`, `dist/darwin-x64/teams-audio-helper` |
| Packaged | `resources/teams-audio/teams-audio-helper.exe` | `Bee.app/Contents/Resources/teams-audio/teams-audio-helper` |

`dist/` and `build/` are not committed. CI builds the helpers before packaging (`.github/workflows/ci.yml`,
`.github/workflows/release-windows.yml`). Both are unsigned, like Bee; electron-builder signs them with Bee when a signing
identity is set.

## Protocol (version 2)

Version 2 added `--image` (Windows), widened `--bundle-id` (macOS) to the call app allowlist, and added `targetImages` /
`targetBundleIds` to `--protocol`. stdout, stderr codes and exit codes are as in version 1.

Bee's side is `src/core/teams-audio-protocol.ts` (constants, parsing, framing) and `src/main/teams-audio-capture.ts`
(the process). CI runs `scripts/check-helper-protocol.mjs` on each built helper to check it prints the same values.

### Arguments

| Argument | Meaning |
| --- | --- |
| *(none)* | Find Teams, capture it, write PCM to stdout until stopped. |
| `--image <name>` | Windows: capture this app (and its process tree) instead of Teams. Repeatable. An image outside the allowlist is a usage error. Bee passes the call app's image(s): `--image ms-teams.exe --image teams.exe`, `--image zoom.exe`, or the Meet browser's (`--image chrome.exe`). |
| `--pid <id>` | Windows: start from this process (the call window's); the helper climbs to the top of the target's tree. Ignored unless it is the target: the helper reports `no-teams`. macOS: narrow to this app (its helper apps stay in). |
| `--bundle-id <id>` | macOS: capture only this app (and its helper apps) instead of Teams. Repeatable. A bundle id outside the allowlist is a usage error. |
| `--request-permission` | macOS: ask for Screen Recording (the system prompt shows once), print `granted` or `denied`, exit. Windows: prints `granted`. Never captures. |
| `--version` | Print `teams-audio-helper protocol=2` to stdout and exit 0. Never opens audio, so it cannot hang (CI runs it). |
| `--protocol` | Print the protocol constants (version, sample rate, exit codes, Teams ids, the target allowlist, capture mode) as one JSON object to stdout and exit 0. Never opens audio. CI compares it with `src/core/teams-audio-protocol.ts` (`scripts/check-helper-protocol.mjs`). |
| `--help` | Print usage to stdout and exit 0. |

### stdout

Raw PCM, no header: **16 kHz, mono, signed 16-bit little-endian**, continuous while the target plays sound. Bee's speech-to-text
takes 16 kHz (`WAV_SAMPLE_RATE` in `src/core/speech.ts`). The helper converts whatever Windows or ScreenCaptureKit gives it:
Windows converts to 16 kHz mono itself (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`), or the helper asks for 48 kHz stereo and
downmixes and low-passes (96-tap windowed sinc) before keeping every third sample; macOS converts with `AVAudioConverter`.
A helper may stop writing while the target is silent; Bee fills gaps with silence so a phrase in progress still ends.

### stderr

One line per state change: `status=<code>`, then optionally ` hr=0x…` (a Windows HRESULT), ` err=<n>` (a macOS error code) or
` tree=not-target`. Codes only: never audio, names, window titles or words. Bee reads the code and drops the rest of the line.

| Code | Meaning |
| --- | --- |
| `ready` | Capturing; PCM follows on stdout. |
| `stopped` | Stopped cleanly (stdin closed, a signal). |
| `granted` | `--request-permission`: Screen Recording is on (always on Windows). |
| `denied` | macOS Screen Recording is off for Bee (or the user declined). Windows: the audio service refused (`E_ACCESSDENIED`). |
| `no-teams` | The target app (Teams, Zoom or the browser) is not running, or it quit during the capture. The code keeps its version 1 name. |
| `unsupported` | The OS is below the floor, or refused per-app capture. |
| `failed` | Anything else, including a target process tree that holds a program that is not the target. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean stop: stdin closed (Bee's stop, or Bee quit), SIGTERM or SIGINT (macOS), Ctrl+C (Windows), or stdout closed. |
| 2 | Usage error. |
| 3 | Unsupported OS. |
| 4 | Permission denied. |
| 5 | Target app not running (`noTeams` in `--protocol`). |
| 6 | Failed. |

### Lifetime

Bee starts the helper with stdin, stdout and stderr as pipes. To stop, Bee closes stdin; the helper stops capture and exits 0.
After 2 s Bee kills it. If Bee dies, stdin closes the same way, so a helper never outlives Bee. A helper whose stdin is not a
pipe (a terminal) runs until Ctrl+C.

## Running a helper by hand

```powershell
# Windows, in a Teams call. Writes raw PCM; import as 16 kHz mono 16-bit signed little-endian in Audacity.
native\teams-audio\dist\win32-x64\teams-audio-helper.exe > teams.raw
```

```bash
# macOS, from a terminal that has Screen Recording (the terminal, not Bee, is asked).
native/teams-audio/dist/darwin-arm64/teams-audio-helper > teams.raw
```

```powershell
# Windows, in a Zoom call, or a Google Meet call in Chrome (every Chrome tab is heard).
native\teams-audio\dist\win32-x64\teams-audio-helper.exe --image zoom.exe > zoom.raw
native\teams-audio\dist\win32-x64\teams-audio-helper.exe --image chrome.exe > meet.raw
```

```bash
# macOS
native/teams-audio/dist/darwin-arm64/teams-audio-helper --bundle-id us.zoom.xos > zoom.raw
native/teams-audio/dist/darwin-arm64/teams-audio-helper --bundle-id com.google.chrome > meet.raw
```

Play other audio at the same time (music, a video in another browser) and check it is not in the file.
