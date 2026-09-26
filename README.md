# Bee

## Install (Windows)

**Installer (recommended):** download `Bee.Setup.x.y.z.exe` from [Releases](https://github.com/vvedantb/bee/releases) and run it. The app is not code-signed yet, so Windows SmartScreen may warn — choose More info → Run anyway.

**Portable:** download `Bee-x.y.z-win.zip`, unzip, run `Bee.exe`.

**From source:**
```powershell
npm install
npm run dist:win
# outputs under release/
```

Bee is a desktop overlay for meetings. It sits as a small "notch" at the top centre of the screen. It listens to the meeting, finds relevant local notes, ranks them with Jev and shows one or two short tips from GPT-6 Luna.

Windows comes first. macOS support is planned.

Typical use: in a weekly meeting someone says "last time we discussed the Acme renewal". Bee hears it, finds your Acme notes, ranks them with Jev and shows a tip. If someone asks a direct question ("when does SSO ship?", "what's 15% of 18,000?"), the tip answers it from your notes or general knowledge.

## Requirements

- Windows 10 or 11 (x64). macOS and Linux also run in development.
- Node.js 22 or later, with npm.
- A Vercel AI Gateway API key with access to `xai/grok-stt`, `openai/gpt-6-luna` and `typesafe-ai/jev`.
- A Bee account. Sign-in uses Clerk (the vedantb.com instance). See [Sign-in (Clerk)](#sign-in-clerk).

## Run on Windows

In PowerShell:

```powershell
git clone <repo-url> bee
cd bee
npm install

# Optional: seed the Gateway key for this shell. You can also paste it in Settings.
$env:BEE_AI_GATEWAY_API_KEY = "vck_..."

npm run dev
```

`npm run dev` starts Electron with hot reload. The notch appears at the top centre of the primary display.

To run the production build without packaging:

```powershell
npm run build
npm start
```

To build a Windows installer (NSIS, x64) into `release/`:

```powershell
npm run dist:win
```

The installer is not code-signed. Windows SmartScreen will warn on first run until signing is set up.

## Use

1. Click **▾** on the notch to open the panel, then sign in (or sign up). Bee does not run guidance until you are signed in.
2. Open **Settings** and paste your AI Gateway key, then click **Save**.
3. Click the **microphone** on the notch and talk. The bar in the mic button shows the input level. Each phrase you say runs the pipeline. Bee does not show what was said; only tips and notes appear. Click the microphone again to stop.
4. To test without speaking, use **Manual test** at the bottom of **Live**: type a line (or leave it blank for a sample) and click **Simulate meeting line**. Typed and spoken lines take the same path.
5. Bee retrieves matching notes, ranks them with Jev, and shows up to two tips. The first tip also shows in the collapsed notch.

Notes are markdown files in the notes folder (Settings shows the path and has an **Open** button). On Windows this is `%APPDATA%\Bee\notes`. Four fictional seed notes are written the first time the folder is empty. Edits are picked up on the next line; no restart is needed.

**Meeting mode** hides Bee from screen sharing and keeps it above full-screen apps.

### Speech-to-text

Bee transcribes with **Grok STT** (`xai/grok-stt`) through Vercel AI Gateway, using the same Gateway key as Luna and Jev.

1. The mic is captured with Web Audio. A simple level detector cuts the audio into phrases: speech, then 0.8 s of silence, up to 15 s per phrase. Blips under 0.3 s are dropped without a Gateway call.
2. Each phrase is sent to the main process as a 16 kHz mono WAV. Main calls Grok STT (flex tier) and returns the text.
3. The text joins a short internal buffer (the last 8 lines), and the pipeline runs. The words are never shown on screen.

If a phrase fails to transcribe, the notch shows a short error (for example "Speech-to-text failed: AI Gateway authentication failed…"). The mic stays on and the error clears after the next phrase succeeds. Without a key, the notch says to add one in Settings.

Bee no longer uses the Web Speech API. Electron could not reach Google's speech service, so it failed with a network error.

To check it by hand: sign in, click the mic, say "when does SSO ship for enterprise customers?". The Q4 roadmap notes and a tip should appear. `npm run test:e2e` runs the same path in Electron with a fake microphone (see [Tests](#tests)).

### Updates

Bee checks the [latest GitHub release](https://github.com/vvedantb/bee/releases/latest) at start-up. When a newer version has an installer for your platform, a download icon shows on the notch. **Settings → Updates** shows your version, **Check for updates**, then **Download update** and **Quit & install**. On Windows, Bee downloads the NSIS installer to the temp folder, opens it and quits; the installer replaces Bee and starts it again. On macOS it opens the `.dmg`. Offline, or with no release published, Settings shows a short message and Bee carries on. The installer is unsigned, so SmartScreen may warn.

The tray icon has Show/hide, Open notes folder and Quit. The avatar in the panel's tab bar manages your account and signs you out.

## Sign-in (Clerk)

Bee uses [`@clerk/electron`](https://www.npmjs.com/package/@clerk/electron) with the **vedantb.com** Clerk production instance.

| Setting | Value |
| --- | --- |
| Publishable key | `pk_live_Y2xlcmsudmVkYW50Yi5jb20k` (override with `VITE_CLERK_PUBLISHABLE_KEY` at build time) |
| Frontend API host | `clerk.vedantb.com` |
| Renderer origin | `bee://renderer` (Bee loads `bee://renderer/`, not `file://`) |
| OAuth redirect | `bee://renderer/` |

One-off setup in the [Clerk Dashboard](https://dashboard.clerk.com) for the vedantb.com instance:

1. **Native applications → enable Native API.** Without it, Clerk rejects Bee with "Production Keys are only allowed for domain vedantb.com" and the panel shows "Sign-in could not load".
2. **Allowlist the redirect URLs** `bee://renderer` and `bee://renderer/*` (Native applications → allowlist for mobile SSO redirect).
3. Turn on the sign-in methods you want (email, Google and so on) under **User & authentication**.

Clerk session tokens are stored by the main process, encrypted with `safeStorage`. Without an OS keyring they are not saved, so you sign in again after each restart.

Social sign-in opens the system browser and returns through the `bee://` deep link. The installer registers the `bee` scheme. In `npm run dev` on Windows, the scheme is registered to the bare Electron binary, so social sign-in may not return to the app; use email sign-in in development, or test social sign-in with a packaged build.

## Settings and secrets

| Field | Storage | Used in v1 |
| --- | --- | --- |
| AI Gateway API key | Encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) | Yes |
| Claude OAuth token (reserved) | Encrypted the same way | No. Stored only, for a later version |
| Meeting mode | Plain JSON | Yes |

Settings live in `settings.json` in the Electron user data folder. Secrets never reach the renderer: the UI only sees whether a key is set. A saved key shows as `•••••••• (saved)` with a **Replace** button; the real key is never put in the page.

If no key is saved, Bee uses `BEE_AI_GATEWAY_API_KEY` from the environment. A saved key takes precedence.

On Linux without a keyring (for example, under Xvfb), Electron cannot encrypt to disk. Bee then keeps secrets in memory for the session only, and Settings says so.

## Tests

```powershell
npm test               # unit tests: retrieval, Jev ranking parser, Luna prompt, pipeline, sign-in gate, phrase detection, WAV, STT, update checks
npm run test:gateway   # live smoke test against Vercel AI Gateway (needs BEE_AI_GATEWAY_API_KEY)
npm run test:e2e       # Electron E2E: fake mic → Grok STT → Jev → Luna (needs BEE_AI_GATEWAY_API_KEY; xvfb-run on Linux)
npm run typecheck
```

`test:gateway` makes five calls:

1. `xai/grok-stt`: transcribes `test/fixtures/sso-question.wav` (a synthesised question with silence either side).
2. `xai/grok-stt` with an invalid key: checks for a short `Speech-to-text failed:` error.
3. `openai/gpt-6-luna`: one short guidance completion.
4. `typesafe-ai/jev`: scores three note snippets against a fake transcript and checks that the relevant note ranks first.
5. `typesafe-ai/jev` with an invalid key: checks that ranking fails open, keeps the original order, and returns a clear error.

`test:e2e` builds the app, then starts Electron with Chromium's fake audio device playing the same WAV. A small harness (`test/e2e/`) loads Bee's real preload and main IPC handlers, and a page that runs Bee's real mic capture and phrase detector. It checks that Grok STT returns the question, the roadmap note ranks first and Luna gives a tip. It skips Clerk and sends an unsigned token with Bee's issuer, which is all the main-process gate checks.

Both fail straight away with a clear message if `BEE_AI_GATEWAY_API_KEY` is not set.

## Manual steps and known limits

- **Gateway key.** Create one in the Vercel dashboard (AI Gateway → API keys).
- **Clerk.** Enable Native API and allowlist `bee://renderer` / `bee://renderer/*`. See [Sign-in (Clerk)](#sign-in-clerk).
- **Electron binary.** `npm install` does not download Electron itself. It downloads on first `npm run dev` or `npm start`. On a restricted network, allow `github.com` downloads or set `ELECTRON_MIRROR`.
- **Speech-to-text on Windows.** Not yet tested on a real Windows machine with a microphone. The full path was checked in Electron on Linux with a fake microphone and live Grok STT. The speech threshold (about −40 dBFS) is fixed and not tuned; a very quiet mic may never start a phrase.
- **Microphone.** Windows asks for microphone permission the first time you click **Mic**. If it is blocked, allow desktop apps under Settings → Privacy & security → Microphone.
- **Code signing.** Not configured. Add a certificate to `build.win` in `package.json` before distributing.
- **Transparency on Linux.** Without a compositor (for example, Xvfb), the area around the notch may show as black rather than transparent.
- **Not tested here.** Encrypted key storage across restarts was not exercised on real Windows in this build. The Linux in-memory path and the unpacked Windows package were checked.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together, including the Jev prompt format.

## Licence

MIT. See [LICENSE](LICENSE). Instrument Sans is bundled under the SIL Open Font License 1.1 (`src/renderer/src/fonts/OFL.txt`).
