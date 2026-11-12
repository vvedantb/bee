# Call audio helpers

Small native programs that let Bee hear **everything the computer plays** (all system audio, as Cluely does) while Bee's mic
is on (Live → Meeting → **Hear other people in calls**), so Bee hears the other people in any call app. They never capture
the screen, and the macOS helper leaves Bee's own sound out. The folder and binary keep their old `teams-audio` names.

| | Windows | macOS |
| --- | --- | --- |
| Source | `windows/teams-audio-helper.cpp` (C++17, Win32 and COM only) | `macos/main.swift` (Swift 5, Apple frameworks only) |
| How | WASAPI loopback on the default playback device: `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eConsole)`, `AUDCLNT_STREAMFLAGS_LOOPBACK`. Follows the default device when it changes (headphones plugged in) or goes away | ScreenCaptureKit: an `SCContentFilter` on the main display that excludes only Bee (`app.bee.desktop` and its helper apps), `capturesAudio`, `excludesCurrentProcessAudio`; 2 × 2 px video at 1 frame a second that is dropped unread |
| OS floor | Windows 10 | macOS 13 (ScreenCaptureKit audio) |
| Permission | None | Screen Recording for Bee ("Screen & System Audio Recording" on macOS 15). The helper never prompts unless run with `--request-permission` |
| Build | `npm run build:teams-audio:win` (`scripts/build-teams-audio-windows.ps1`: CMake and Visual Studio 2022 C++) | `npm run build:teams-audio:mac` (`scripts/build-teams-audio-macos.sh`: `xcrun swiftc` for arm64 and x64, ad hoc signed) |
| Output | `dist/win32-x64/teams-audio-helper.exe` | `dist/darwin-arm64/teams-audio-helper`, `dist/darwin-x64/teams-audio-helper` |
| Packaged | `resources/teams-audio/teams-audio-helper.exe` | `Bee.app/Contents/Resources/teams-audio/teams-audio-helper` |

`dist/` and `build/` are not committed. CI builds the helpers before packaging (`.github/workflows/ci.yml`,
`.github/workflows/release-windows.yml`). Both are unsigned, like Bee; electron-builder signs them with Bee when a signing
identity is set.

## Protocol (version 3)

Version 3 hears all system audio and takes no target: `--image`, `--bundle-id` and `--pid` (version 2) are gone and are usage
errors. stdout, stderr codes and exit codes are as in version 2, plus `status=device-changed` (Windows).

Bee's side is `src/core/teams-audio-protocol.ts` (constants, parsing, framing) and `src/main/teams-audio-capture.ts`
(the process). CI runs `scripts/check-helper-protocol.mjs` on each built helper to check it prints the same values.

### Arguments

| Argument | Meaning |
| --- | --- |
| *(none)* | Capture all system audio, write PCM to stdout until stopped. |
| `--request-permission` | macOS: ask for Screen Recording (the system prompt shows once), print `granted` or `denied`, exit. Windows: prints `granted`. Never captures. |
| `--version` | Print `teams-audio-helper protocol=3` to stdout and exit 0. Never opens audio, so it cannot hang (CI runs it). |
| `--protocol` | Print the protocol constants (version, sample rate, exit codes, capture mode; macOS: Bee's bundle id) as one JSON object to stdout and exit 0. Never opens audio. CI compares it with `src/core/teams-audio-protocol.ts`. |
| `--help` | Print usage to stdout and exit 0. |

### stdout

Raw PCM, no header: **16 kHz, mono, signed 16-bit little-endian**. Bee's speech-to-text takes 16 kHz (`WAV_SAMPLE_RATE` in
`src/core/speech.ts`). Windows converts to 16 kHz mono itself (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`), or the helper asks for
48 kHz stereo and downmixes and low-passes (96-tap windowed sinc) before keeping every third sample; macOS converts with
`AVAudioConverter`. Windows loopback gives no data while nothing plays, so the Windows helper writes silence for that time.

### stderr

One line per state change: `status=<code>`, then optionally ` hr=0x…` (a Windows HRESULT) or ` err=<n>` (a macOS error code).
Codes only: never audio, names, window titles or words. Bee reads the code and drops the rest of the line.

| Code | Meaning |
| --- | --- |
| `ready` | Capturing; PCM follows on stdout. |
| `stopped` | Stopped cleanly (stdin closed, a signal). |
| `granted` | `--request-permission`: Screen Recording is on (always on Windows). |
| `denied` | macOS Screen Recording is off for Bee (or the user declined). Windows: the audio service refused (`E_ACCESSDENIED`). |
| `device-changed` | Windows: the default playback device changed or went away; the helper opens the new one and carries on. |
| `unsupported` | The OS is below the floor, or refused the capture. |
| `failed` | Anything else, including no playback device for about 10 tries. |
| `no-teams` | Version 2 only (no target app); version 3 helpers never print it. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean stop: stdin closed (Bee's stop, or Bee quit), SIGTERM or SIGINT (macOS), Ctrl+C (Windows), or stdout closed. |
| 2 | Usage error. |
| 3 | Unsupported OS. |
| 4 | Permission denied. |
| 5 | Version 2 only: target app not running (`noTeams` in `--protocol`). |
| 6 | Failed. |

### Lifetime

Bee starts the helper with stdin, stdout and stderr as pipes. To stop, Bee closes stdin; the helper stops capture and exits 0.
After 2 s Bee kills it. If Bee dies, stdin closes the same way, so a helper never outlives Bee. A helper whose stdin is not a
pipe (a terminal) runs until Ctrl+C.

## Running a helper by hand

```powershell
# Windows. Play a video or join a call. Import as 16 kHz mono 16-bit signed little-endian in Audacity.
native\teams-audio\dist\win32-x64\teams-audio-helper.exe > system.raw
```

```bash
# macOS, from a terminal that has Screen Recording (the terminal, not Bee, is asked).
native/teams-audio/dist/darwin-arm64/teams-audio-helper > system.raw
```

Switch headphones on and off while it runs (Windows) and check the file carries on.
