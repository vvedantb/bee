# Bee

Bee is a desktop overlay for meetings. It sits as a small "notch" at the top centre of the screen. It listens to the meeting, finds relevant local notes, ranks them with Jev and shows one or two short tips from GPT-6 Luna.

Windows comes first. macOS support is planned.

> **v1 status.** Live speech-to-text is stubbed. Use **Simulate meeting line** to inject transcript text. The microphone button starts capture and shows a level meter, but it does not transcribe yet.

## Requirements

- Windows 10 or 11 (x64). macOS and Linux also run in development.
- Node.js 22 or later, with npm.
- A Vercel AI Gateway API key with access to `openai/gpt-6-luna` and `typesafe-ai/jev`.

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

1. Click **▾** on the notch to open the panel.
2. Open **Settings** and paste your AI Gateway key, then click **Save**.
3. Go back to **Live**. Type a line (or leave the box blank for a sample) and click **Simulate meeting line**.
4. Bee retrieves matching notes, ranks them with Jev, and shows tips. The first tip also shows in the collapsed notch.

Notes are markdown files in the notes folder (Settings shows the path and has an **Open** button). On Windows this is `%APPDATA%\Bee\notes`. Four fictional seed notes are written the first time the folder is empty. Edits are picked up on the next simulated line; no restart is needed.

**Meeting mode** hides Bee from screen sharing and keeps it above full-screen apps.

The tray icon has Show/hide, Open notes folder and Quit.

## Settings and secrets

| Field | Storage | Used in v1 |
| --- | --- | --- |
| AI Gateway API key | Encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) | Yes |
| Claude OAuth token (reserved) | Encrypted the same way | No. Stored only, for a later version |
| Meeting mode | Plain JSON | Yes |

Settings live in `settings.json` in the Electron user data folder. Secrets never reach the renderer: the UI only sees whether a key is set.

If no key is saved, Bee uses `BEE_AI_GATEWAY_API_KEY` from the environment. A saved key takes precedence.

On Linux without a keyring (for example, under Xvfb), Electron cannot encrypt to disk. Bee then keeps secrets in memory for the session only, and Settings says so.

## Tests

```powershell
npm test               # unit tests: retrieval, Jev ranking parser, Luna prompt builder, pipeline
npm run test:gateway   # live smoke test against Vercel AI Gateway (needs BEE_AI_GATEWAY_API_KEY)
npm run typecheck
```

`test:gateway` makes three calls:

1. `openai/gpt-6-luna`: one short guidance completion.
2. `typesafe-ai/jev`: scores three note snippets against a fake transcript and checks that the relevant note ranks first.
3. `typesafe-ai/jev` with an invalid key: checks that ranking fails open, keeps the original order, and returns a clear error.

It fails straight away with a clear message if `BEE_AI_GATEWAY_API_KEY` is not set.

## Manual steps and known limits

- **Gateway key.** Create one in the Vercel dashboard (AI Gateway → API keys). There is no other external setup.
- **Electron binary.** `npm install` does not download Electron itself. It downloads on first `npm run dev` or `npm start`. On a restricted network, allow `github.com` downloads or set `ELECTRON_MIRROR`.
- **Microphone.** Windows asks for microphone permission the first time you click **Mic**. If it is blocked, allow desktop apps under Settings → Privacy & security → Microphone.
- **Code signing.** Not configured. Add a certificate to `build.win` in `package.json` before distributing.
- **Transparency on Linux.** Without a compositor (for example, Xvfb), the area around the notch may show as black rather than transparent.
- **Not tested here.** Encrypted key storage across restarts was not exercised on real Windows in this build. The Linux in-memory path and the unpacked Windows package were checked.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together, including the Jev prompt format.

## Licence

MIT. See [LICENSE](LICENSE).
