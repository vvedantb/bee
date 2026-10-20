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

## Install (macOS)

Download `Bee-x.y.z-arm64.dmg` (Apple Silicon) or `Bee-x.y.z.dmg` (Intel), or the matching `-mac.zip` from [Releases](https://github.com/vvedantb/bee/releases). Open the dmg and drag Bee to Applications. Builds are not signed or notarised yet, so Gatekeeper will warn: right-click Bee, choose **Open**, then confirm.

- **Microphone.** macOS asks the first time Bee starts. If you decline, allow Bee under System Settings → Privacy & Security → Microphone.
- **Screen Recording.** Only needed if system (meeting) audio capture is used. It is best-effort: Bee always keeps the microphone as the main input, and carries on without system audio if it is unavailable.
- **Menu bar.** Bee has no Dock icon. The tray icon is a menu bar extra: click it for Show / hide, Open notes folder and Quit.
- **Shortcut.** `Cmd+Shift+Space` shows or hides Bee (`Ctrl+Shift+Space` on Windows and Linux). If another app holds the shortcut, Bee logs a warning and carries on.
- **Notes folder.** `~/Library/Application Support/Bee/notes`.
- **Teams detector.** Windows only. On macOS use **Live → Manual test → Simulate Teams meeting**.

**From source:**
```bash
npm install
npm run dist:mac
# outputs under release/ (dmg and zip, one each for arm64 and x64)
```

Signing is off by default. To sign and notarise, set `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder, and set `build.mac.notarize` to `true` (it is `false` now), with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment.

Bee is a desktop overlay for meetings. It sits as a small "notch" at the top centre of the screen. It listens to the meeting, finds relevant local notes, ranks them with Jev and shows one or two short tips from GPT-6 Luna. When a question is about a public or current fact that the notes do not cover, Luna can search the web, and the Live tab lists the source links under the tips. This uses the same Gateway key.

Windows and macOS are supported. The Teams detector is Windows only.

Typical use: in a weekly meeting someone says "last time we discussed the Acme renewal". Bee hears it, finds your Acme notes, ranks them with Jev and shows a tip. If someone asks a direct question ("when does SSO ship?", "what's 15% of 18,000?"), the tip answers it from your notes or general knowledge.

## Requirements

- Windows 10 or 11 (x64), or macOS (Apple Silicon arm64 or Intel x64). Linux runs in development.
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
5. Bee retrieves matching notes, ranks them with Jev, and shows up to two tips. While Luna works, the notch shows what it is doing (for example "Searching the web"). When the answer arrives, the notch grows downward into an island with the tips and any source links. Click **×** to dismiss it. It closes by itself after about 10 seconds if you leave the pointer off it, and the same tips stay on **Live**. Click the notch text to show the last answer again.
6. When the meeting ends, click **End meeting & save summary** on **Live**. Bee writes `meeting-YYYY-MM-DD-HHmm.md` to the notes folder, with decisions, action items (with owners), topics and the notes cited. Click **Open summary** to view it. Next time, Bee finds it like any other note. Without a key, or if the AI call fails, Bee saves a plain summary with the meeting lines instead.

Notes are markdown files in the notes folder (Settings shows the path and has an **Open** button). On Windows this is `%APPDATA%\Bee\notes`; on macOS it is `~/Library/Application Support/Bee/notes`. Four fictional seed notes are written the first time the folder is empty. Edits are picked up on the next line; no restart is needed.

Luna can also list, search and read these notes with file tools, for questions the top three notes do not cover. In Settings, **Extra folders Luna may read** takes one absolute path per line; Luna can read them but never write to them. Luna can add to a note (create or append, `.md` only, notes folder only) when you clearly ask it to. It never overwrites a file. Limits: paths must stay inside the notes folder or an approved folder (`..`, either slash style, and symbolic links are refused); binary files and files over 256 KiB are skipped; lists stop at 200 entries, searches at 20 hits, and a read returns at most 64 KiB.

**Meeting mode** hides Bee from screen sharing and keeps it above full-screen apps.

### Link suggestions and personalised links

When a spoken line or a tip names a website (a URL, `convex.dev`, "convex dot dev", or a short list of names such as GitHub or Vercel), Bee shows a chip under the tips, with the site's icon. The chip shows at once, even while Luna is still working. A click opens the link in your default browser. **×** hides the chip for this turn. Bee never opens a link by itself.

**Personalised link suggestions** pick the exact page you mean. For "vercel logs for vibot", the chip can read `vercel.com › vibot › logs` and open that page, taken from your browsing history or bookmarks in [vmem](https://github.com/vedantb2/vmem), when vmem is connected.

1. Open the **Connectors** tab (between **Live** and **Settings**) and click **Connect** on **vmem**. There is no API key: vmem is an MCP connector (`https://clear-bear-690.eu-west-1.convex.site/mcp`) that uses MCP OAuth. Connect opens your system browser to sign in; the browser returns to a one-time server on `127.0.0.1` (random port) and Bee stores the tokens encrypted in the main process. Disconnect removes them. **Eva** is a second preset (`https://dazzling-dogfish-581.eu-west-1.convex.site/mcp`) with the same OAuth sign-in and no API key. **Add custom** sets up any other MCP server; a remote one with authentication "None" signs in the same way. Any enabled server named `vmem`, or on the `vmem.vedantb.com` or `vmem.projectv.uk` host, counts.
2. Keep the **Gateway key** set in **Settings**: Jev, which makes the choice, runs through AI Gateway.
3. Use the **Personalised link suggestions** switch in **Settings**. It is on by default when an enabled vmem connector exists, and off otherwise. Once you change it, Bee keeps your choice.

Without a vmem connector, Jev still scores the plain domain chip, and can remove it when no link helps.

How it works: the cheap detector runs first, and nothing else runs when it finds no site. Bee opens one connection to vmem at app start (when signed in) and after each Connectors change, and reuses it. For each chip, main searches it through Bee's MCP client (`memory_search`, or the closest search tool), once for browsing history and once for bookmarks, for pages on that domain, keeps up to five, and asks Jev (`typesafe-ai/jev`) two things on a 0 to 3 scale: should a link show at all, and which page fits best. A chip shows only when both scores are at least 2 (`LINK_MIN_SCORE` in `src/core/link-rank.ts`). A low "should show" score removes the chip. A missing or invalid answer keeps the plain domain chip.

It fails open. The whole step has a 2 second limit. With the switch off or the Gateway key missing, you keep the plain domain chip. If vmem is not connected, is offline or is slow, Jev still runs on the plain domain (the MCP connection is kept warm, and each search call has a 1 s limit). On any error or timeout you keep the plain domain chip, and Bee logs a debug line (`Bee: personalised links fell back: …`). Each turn is looked up once.

**Privacy:** with the switch on, the current line (and the tip text for chips from tips) goes to Jev through AI Gateway, and to your vmem connector when one is enabled. With it off, nothing is sent and plain chips still work. Keys and connector tokens stay in the main process and are encrypted like the Gateway key.

**Icons** are fetched by the main process, since the window's content policy blocks remote images. Bee tries `/favicon.ico`, then the icon named in the site's home page, then Google's favicon service (`google.com/s2/favicons`, which sees the domain name). Icons are kept as small data URLs in memory and in the `favicons` folder of the user data folder for 7 days. Until an icon loads, or if none does, the chip shows a globe. Loopback addresses (127.0.0.0/8, 0.0.0.0, ::1) and dotless names are never fetched or opened.

### Speech-to-text

Bee transcribes with **Grok STT** (`xai/grok-stt`) through Vercel AI Gateway, using the same Gateway key as Luna and Jev.

1. The mic is captured with Web Audio. A simple level detector cuts the audio into phrases: speech, then 0.8 s of silence, up to 15 s per phrase. Blips under 0.3 s are dropped without a Gateway call. The mic is primary; system audio is mixed in when loopback or ScreenCaptureKit works.
2. Each phrase is sent to the main process as a 16 kHz mono WAV. Main calls Grok STT (flex tier) and returns the text.
3. The text joins a short internal buffer (the last 8 lines), and the pipeline runs. The words are never shown on screen.

If a phrase fails to transcribe, the notch shows a short error (for example "Speech-to-text failed: AI Gateway authentication failed…"). The mic stays on and the error clears after the next phrase succeeds. Without a key, the notch says to add one in Settings.

Bee no longer uses the Web Speech API. Electron could not reach Google's speech service, so it failed with a network error.

To check it by hand: sign in, click the mic, say "when does SSO ship for enterprise customers?". The Q4 roadmap notes and a tip should appear. `npm run test:e2e` runs the same path in Electron with a fake microphone (see [Tests](#tests)).

### Updates

Bee checks the [latest GitHub release](https://github.com/vvedantb/bee/releases/latest) at start-up. When a newer version has an installer for your platform, a download icon shows on the notch. **Settings → Updates** shows your version, **Check for updates**, then **Download update** and **Quit & install**. On Windows, Bee downloads the NSIS installer to the temp folder, opens it and quits; the installer replaces Bee and starts it again. On macOS it opens the `.dmg`. Offline, or with no release published, Settings shows a short message and Bee carries on. The installer is unsigned, so SmartScreen may warn.

The tray icon (the menu bar extra on macOS) has Show/hide, Open notes folder and Quit. The avatar in the panel's tab bar manages your account and signs you out.

## Teams mode

Teams mode lets teammates who are in the same Microsoft Teams meeting pool what they say, so each person's Bee sees the whole conversation and writes a speaker-labelled summary. Bee stays a desktop notch. It never joins the call, and it uses no Teams bot, no Teams local API and no Microsoft Graph or calendar access.

### Set up

1. Deploy the relay (Convex HTTP backend; shared handler in `relay/src`). See [relay/README.md](relay/README.md).
2. Start Bee with `BEE_RELAY_URL` set to the Convex site URL, for example `https://academic-ostrich-889.eu-west-1.convex.site`. Without it, Teams mode is off and Bee works solo as before.
3. One person opens **Settings → Team**, types a team name and clicks **Create team**. Settings shows the invite link (`bee://team/XXXX-XXXX`) and the code. **Copy** puts the link on the clipboard.
4. Teammates click the link (Bee opens with the code filled in) or paste the code in **Settings → Team**, then click **Join team**. Team membership is an allowlist of Clerk user ids. **Leave team** removes you.

### In a meeting

1. **Detection.** On Windows, Bee checks every few seconds whether desktop Teams is in a call: a Teams process that holds the microphone (Windows microphone privacy registry) or shows a meeting or call window title. This is a best-effort heuristic. Bee also lists each open meeting window by its title. On macOS and Linux there is no detector; use **Live → Manual test → Simulate Teams meeting**.
2. **Popup.** After about 10 seconds of stable detection, a card opens under the notch:
   - **Join "Alice, Bob"**: the best open sync on your team. Syncs you were invited to come first, then syncs started within 10 minutes of your meeting whose members are in a meeting now. The subtitle shows who invited you or when it started, and its word code.
   - **Start new sync** (or **Start meeting sync** when there is nothing to join).
   - **Other syncs (n)** and **Join by code** (for example `amber-otter`) as secondary links. **×** closes the card for this meeting.

   Nothing joins automatically. Timing and presence only rank the choices; you always click.

   If two or more Teams windows look like calls, the card first asks **Which meeting?** and lists them by title. Pick the one you are in; only then are syncs offered. If two or more syncs match equally well (two invites, or two live syncs started near your meeting), there is no one-click **Join**: the card lists them all as equal choices. Once you join or start, the sync stays bound to that meeting. Other meeting windows are ignored until it ends. When that window has been closed for 15 seconds, Bee leaves the sync, even if another meeting is still open.
3. **After starting.** An optional **Invite who is here** step lists teammates who are in a meeting now. Nobody is pre-ticked. You can also paste the word code in the Teams chat.
4. **Synced.** The notch shows a team icon with the member count. **Live → Teams sync** shows "Synced with Alice, Bob", **Pause sharing** / **Resume sharing** and **Leave sync**. Your mic phrases go to the sync only while the Bee mic is on and sharing is not paused. Typed test lines stay on your device. Teammates' phrases join your transcript in spoken order, labelled "Alice: …", and feed tips too.
5. **Simultaneous starts.** If a teammate in a meeting started a sync within 30 seconds of yours, both of you see **Merge with Bob's sync?**. It merges only once both tap **Merge**.
6. **Leaving.** When Teams has been out of the call for about 15 seconds, Bee leaves the sync. A new detection always shows a new popup; Bee never rejoins an old sync by itself.
7. **Summary.** **End meeting & save summary** works as before. Each Bee writes its own markdown file locally. With synced lines, the transcript sent to Luna is `Speaker: text`, action items are attributed to the speaker who committed to them, and the file adds a `## Speakers` section that says the transcript is partial (Bee members only).

If the relay cannot be reached, Bee says "Bee is working solo" and carries on with your own lines only.

### Mute gating

Teams' own mute state cannot be read without the Teams local API, which Bee does not use. Sharing is therefore gated on Bee's side: only while the Bee mic is on, only after you joined a sync, and never while **Pause sharing** is on. Muting in Teams alone does not stop Bee from sharing; turn off the Bee mic or pause sharing as well.

### Environment variables

| Variable | Where | Meaning |
| --- | --- | --- |
| `BEE_RELAY_URL` | Bee (main process, run time) | Relay base URL. Overrides the build-time value. |
| `MAIN_VITE_BEE_RELAY_URL` | Bee (build time) | Relay URL baked into an installer. With neither set, Teams mode is off. |
| `CLERK_ISSUER` | Relay | Clerk issuer, default `https://clerk.vedantb.com`. |
| `CLERK_JWKS_URL` | Relay (optional) | JWKS for RS256 checks. Default `<issuer>/.well-known/jwks.json`. |
| `CLERK_AUTHORIZED_PARTIES` | Relay (optional) | Comma-separated `azp` allowlist. |

To show full names without typing them, add a `name` claim to the Clerk session token (Dashboard → Sessions → Customize session token: `{"name": "{{user.full_name}}"}`).

### Risks and limits

- **Detection false positives and misses.** The Windows heuristic can fire on a Teams call that is not a meeting, or on another app's title that mentions a call inside Teams. It can miss new Teams builds with different window titles. It has not yet been tested on a real Windows machine. Back-to-back meetings with no gap look like one meeting.
- **Presence privacy.** Everyone on your team can see when your Bee reports "in a meeting", even if you never join a sync. Consider this before rolling out, and consider a privacy review.
- **Partial summaries.** Only Bee members who joined the sync are captured. Other attendees, and anyone with the Bee mic off, are missing from every summary.
- **Consent.** Each person's summary contains colleagues' words, stored on each device. Tell participants, and get a privacy or legal review before wide use.
- **Wrong-room clicks.** A person can join the wrong sync by clicking the wrong button. Names are shown before joining, and **Leave sync** is one click. There is no "Remove" for uninvited joiners yet.
- **No Microsoft IDs.** Bee has no Microsoft meeting id, so it cannot match a meeting to a sync by itself. It lists concurrent desktop meeting windows (by title) and equally ranked live syncs, and you pick. The session stays bound to that choice until it ends. Syncs are grouped only by who clicked. Two meeting windows with the same title count as one. A mic-only call with no meeting window is treated as one unnamed meeting.
- **Display names.** Without a `name` claim, a user can type any name for themselves when joining the team. They cannot change anyone else's.
- **Unsigned installer.** Windows SmartScreen warns on first run.
- **Relay scale.** One Convex deployment serves every team (kv-backed): fine for a few hundred users. Tokens are checked on every request; phrases are deleted when a sync ends, or 4 hours after it started.

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
| Connector tokens (Connectors tab) | Encrypted the same way | Yes |
| Personalised links switch, meeting mode | Plain JSON | Yes |

Settings live in `settings.json` in the Electron user data folder. Secrets never reach the renderer: the UI only sees whether a key is set. A saved key shows as `•••••••• (saved)` with a **Replace** button; the real key is never put in the page.

If no key is saved, Bee uses `BEE_AI_GATEWAY_API_KEY` from the environment. A saved key takes precedence.

On Linux without a keyring (for example, under Xvfb), Electron cannot encrypt to disk. Bee then keeps secrets in memory for the session only, and Settings says so.

## Tests

```powershell
npm test               # unit tests: retrieval, Jev ranking parser, Luna prompt, meeting summary, pipeline, sign-in gate, phrase detection, WAV, STT, update checks, Teams mode (relay, JWT, room ranking, detection, sync)
npm run test:gateway   # live smoke test against Vercel AI Gateway (needs BEE_AI_GATEWAY_API_KEY)
npm run test:e2e       # Electron E2E: fake mic → Grok STT → Jev → Luna, meeting summary files, Teams sync (needs BEE_AI_GATEWAY_API_KEY; xvfb-run on Linux)
npm run relay:mock     # in-memory relay on http://127.0.0.1:8787 for local Teams mode
npm run typecheck
```

`test:gateway` makes eight calls:

1. `xai/grok-stt`: transcribes `test/fixtures/sso-question.wav` (a synthesised question with silence either side).
2. `xai/grok-stt` with an invalid key: checks for a short `Speech-to-text failed:` error.
3. `openai/gpt-6-luna`: one short guidance completion.
4. `openai/gpt-6-luna`: a current-events question ("who is the current Prime Minister of the UK?"), checked for a tip and at least one `https://` source.
5. `openai/gpt-6-luna`: a question about a local note (a room number in a temp notes folder), checked that the tip holds the answer, so Luna used the file tools.
6. `openai/gpt-6-luna`: a meeting summary from a short transcript, checked for every section and the named owner.
7. `typesafe-ai/jev`: scores three note snippets against a fake transcript and checks that the relevant note ranks first.
8. `typesafe-ai/jev` with an invalid key: checks that ranking fails open, keeps the original order, and returns a clear error.

`test:e2e` builds the app, then starts Electron with Chromium's fake audio device playing the same WAV. A small harness (`test/e2e/`) loads Bee's real preload and main IPC handlers, and a page that runs Bee's real mic capture and phrase detector. It checks that Grok STT returns the question, the roadmap note ranks first and Luna gives a tip. It skips Clerk and sends an unsigned token with Bee's issuer, which is all the main-process gate checks.

The summary E2E uses the same harness without a mic. It runs a short fake meeting, ends it, checks the markdown file in a temp notes folder (every section, the notes cited, the named owner), and checks that the next pipeline run retrieves the summary. It runs once with Luna and once without a key (plain summary).

Both fail straight away with a clear message if `BEE_AI_GATEWAY_API_KEY` is not set.

The live MCP E2E (`test/mcp-live.e2e.test.ts`) is skipped, including under `test:e2e`, unless both `BEE_E2E_MCP_FILE` and `BEE_AI_GATEWAY_API_KEY` are set. `BEE_E2E_MCP_FILE` points to a JSON file (keep it mode 0600) shaped `{ "servers": [{ "id", "name", "url", "bearer"? , "oauth"? }] }`, where `oauth` is the stored MCP OAuth state; the harness re-reads it on every run and writes refreshed tokens back. Run it with `npx electron-vite build && npx vitest run --config vitest.e2e.config.ts test/mcp-live.e2e.test.ts` (on Linux without a display, `test/e2e/run.ts` uses `xvfb-run`). It asks three questions without the mic and checks that Luna names vmem and Eva as Bee's connectors, calls an Eva tool for a table count, and calls a vmem tool for a memory search. The harness prints each MCP call as an `E2E_MCP_CALL` line (tool, server, ok, size, a short preview; never tokens).

The Teams E2E needs no key. The test serves the in-memory relay over HTTP, with a local RS256 key pair and JWKS, and plays "Bob": it creates the team and a sync. Bee's real preload and main (with a stub detector) run as "Alice". Alice joins by invite link, simulates a meeting, takes the popup's **Join**, shares one mic phrase and one while sharing is paused, and receives Bob's phrase. She then writes the summary and turns the meeting off. The test checks that the relay stamped both speakers from their tokens and that the paused phrase never left Alice's device. It also checks that Alice left the sync after the debounce and that the plain summary lists `Alice: …` and `Bob Jones: …` lines and a `## Speakers` section.

The concurrent-meeting E2E (`test/teams-pick.e2e.test.ts`) plays "Bob" and "Carol", each with a live sync. Alice simulates two meeting windows. The test checks that the card asks **Which meeting?** with no one-click sync, and that dismissing it joins nothing. On the next detection Alice picks "Call with Carol" and joins Carol's sync. The test checks that she is only in Carol's sync and that her phrase reached only Carol's.

Unit tests cover the relay (JWT signature, issuer, expiry and `azp` checks; team invite and join; room ids, word codes and membership; phrase stamping; stale members and the 4-hour limit; two-tap merge). They also cover room ranking, the detection debounce, the Windows heuristics against sample `tasklist` and registry output, and the share gate. The last group covers the sync controller with two or three devices on one relay, including concurrent meetings, the "Which meeting?" pick, equally ranked syncs, leaving when the chosen meeting closes, merging, leaving without rejoining, and fail-open.

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
