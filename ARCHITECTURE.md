# Architecture

Bee is an Electron app built with electron-vite, React and TypeScript.

```
src/
  main/       Electron main process: notch window, tray, IPC, settings, notes folder, bee:// protocol, Clerk bridge, Teams detector and sync IPC
  preload/    Sandboxed bridge: exposes window.bee (parses every response with zod) and Clerk's bridge
  renderer/   React UI: collapsed notch, sign-in, expanded panel (Live, Settings), mic capture (mic.ts), phrase detection and WAV (speech.ts)
  shared/     IPC channel names and zod schemas, Clerk config (shared/clerk.ts)
  core/       Pure TypeScript: note chunking, retrieval, Jev ranking, Luna guidance and meeting summaries, Grok STT, pipeline, release version checks,
              Teams mode (relay protocol and client, sync controller, room ranking, detection debounce and heuristics, line merging)
relay/        Bee relay: shared HTTP handler + state + JWKS (Convex HTTP in convex/; in-memory mock for tests)
test/         Live Gateway smoke test (npm run test:gateway), Electron mic, summary and Teams E2E (npm run test:e2e, harness in test/e2e)
resources/    App and tray icons
```

## Flow

```
Mic on (renderer/mic.ts)                           getUserMedia → ScriptProcessorNode, 4096-sample frames
  → renderer/speech.ts                             level meter; phrase detection; 16 kHz WAV
  → window.bee.transcribe({ audio, sessionToken }) preload → IPC
  → main/meeting-ipc.ts: check session, read key
  → core/transcribe                                Grok STT (xai/grok-stt) → text, or null for no words
  ↓
simulateLine(text)  ← also "Simulate meeting line" (Manual test)
  → Clerk getToken()                               no session → "Sign in to Bee"
  → window.bee.runPipeline({ transcript, sessionToken })   preload → IPC
  → main: check session token (main/auth.ts)
  → main: load notes, read API key                 key never leaves main
  → core/retrieve   BM25 keyword search, top 5 snippets
  → core/jev        Jev scores each snippet, re-orders (fails open)
  → core/luna       GPT-6 Luna writes up to 2 tips from the top 3 notes
  → PipelineResult back to the renderer
```

The renderer keeps the last 8 lines (spoken, typed or from synced teammates) and sends them with each run. The lines are not rendered: the Live tab shows tips and notes only. Apart from the Teams sync state (below), the main process holds no meeting state.

## Meeting summary

```
End meeting & save summary (Live tab)
  → store.endMeeting()                              stops the mic; session cleared for the next meeting
  → window.bee.writeMeetingSummary({ transcript, notesCited, tips, sessionToken })
  → main/meeting-ipc.ts: check session, read key
  → core/summary                                    Luna writes Decisions / Action items / Topics (fails open)
  → main/notes.ts writeMeetingSummaryFile          <notes>/meeting-YYYY-MM-DD-HHmm.md
  → { path, usedLlm, error } → "Open summary"      main opens it only if it is a .md directly in the notes folder
```

- **Session** (`renderer/src/store.ts`): the store keeps every line since the last saved summary (up to 200, `SESSION_TRANSCRIPT_MAX`) as `SessionLine { id, own, speakerId, speakerName, text, clientTs, serverTs }`, merged by spoken time (`core/sync-lines.ts`). It also keeps the titles of notes cited in shown results and the tips shown (up to 100 each). The pipeline window is the last 8 session lines, teammates' lines as `Alice: …`. None of it is rendered. If saving fails, the session is restored.
- **Speakers**: a solo session is sent as plain strings (the original path). Once any teammate's line is present, every line is sent as `{ speaker, text }`, own lines under your team display name. `core/summary.ts` then writes `Speaker: text` lines, adds speaker rules to the system prompt (attribute owners by speaker; only Bee members are captured) and adds a `## Speakers` section with a partial-transcript note.
- **File**: `# Meeting summary — YYYY-MM-DD HH:mm` (local time), then `## Decisions`, `## Action items` (owner first when named), `## Topics`, `## Notes cited` and, if any, `## Tips shown`. Bee writes the title, notes cited and tips itself; the model writes only the first three sections. A second summary in the same minute gets `-2`, `-3`… Nothing is overwritten.
- **Recall**: the file is an ordinary note. `chunkNote` splits it into one snippet per `##` section, so next week's "last time we discussed X" retrieves it like any other note.
- **Fail-open**: with no key, or if Luna fails, times out or replies without the three sections, Bee writes a plain summary instead: the same headings, "Not extracted" under Decisions and Action items, and the transcript lines under Topics. The meeting is never lost, and the UI says the summary was saved without AI and why. Real failures (sign-in, disk) show as errors and keep the session.
- The spoken transcript is still never shown on screen. It goes to disk only in the plain summary, inside the user's notes folder. Each run takes a number (`latestRun`); a result is shown only if no newer run has started, so fast speech never shows stale tips.

## Speech-to-text

Production uses **Grok STT** (`xai/grok-stt`) through Vercel AI Gateway, batch mode (`experimental_transcribe`). The Gateway model list names it `spacexai/grok-stt`; on 26 September 2026 both ids returned the same transcript, and Bee uses `xai/grok-stt`. Bee does not use the Web Speech API: in Electron it could not reach Google's speech service and failed with `network`.

- **Capture** (`renderer/src/mic.ts`): mono `getUserMedia` with echo cancellation and noise suppression, into a `ScriptProcessorNode`. No AudioWorklet, so no extra module under the CSP. Frames are about 85 ms at 48 kHz and also drive the level meter.
- **Phrases** (`renderer/src/speech.ts`, no window or React imports): a frame at or above RMS 0.01 counts as speech. A phrase starts with 300 ms of pre-roll and ends after 800 ms of silence, or at 15 s. Phrases with under 300 ms of speech are dropped. On mic off, the phrase in progress is still sent.
- **Upload**: each phrase is encoded as 16 kHz 16-bit mono WAV (about 32 KB a second) and sent over IPC. Main rejects payloads over 2 MB.
- **Order**: phrases are transcribed one at a time, so lines reach the pipeline in the order they were spoken.
- **Output**: text is whitespace-normalised. Empty or punctuation-only results (a cough or a click) count as no words and do not run the pipeline.
- **Errors**: a failed call returns `Speech-to-text failed: <reason>`. The mic stays on, the notch and the Live tab show the message, and it clears after the next successful phrase.

Streaming (`experimental_streamTranscribe`) was not used. Phrase-level batch calls are simpler, and one call per phrase matches one pipeline run per line.

## Updates

`main/updater.ts` and `core/release.ts`. No `electron-updater`: v1 downloads the installer by hand.

1. At start-up (and on **Check for updates**), main fetches `https://api.github.com/repos/vvedantb/bee/releases/latest` (10 s timeout) and compares its tag with `app.getVersion()` (major.minor.patch).
2. It picks the platform installer: Windows `*Setup*.exe` (NSIS), macOS `.dmg`, Linux `.AppImage`. Only URLs under `https://github.com/vvedantb/bee/releases/download/` are accepted.
3. **Download update** saves it to the temp folder as `Bee-update-<version>.<ext>` (our name, never the asset name) and checks the byte count.
4. **Quit & install** opens the file with `shell.openPath` and quits. The one-click NSIS installer replaces Bee and relaunches it. On Linux Bee shows the file in its folder instead.

Failures (offline, HTTP errors, no release, no asset) come back as values and show in Settings. A 404 means no release is published. The renderer never sees a download path.

## Teams mode

Bee never joins the call and uses no Microsoft identity (no bot, no Teams local API, no Graph or calendar). Teammates' Bees pool their own mute-gated mic phrases through the Bee relay. Without a Microsoft meeting id Bee cannot tell two concurrent meetings apart, so grouping is by explicit click only: timing and presence rank the choices, and membership is whoever clicked.

```
main/teams-detector.ts  (Windows: tasklist window titles + mic privacy registry; others: none)
  → core/meeting-tracker   raw reading → stable after 10 s; leave after 15 s false; new epoch per meeting
renderer store: tick every 2 s → window.bee.teams.tick(token) → main/teams-sync.ts → core/sync-controller
  → relay GET /v1/me (every 60 s), PUT /v1/presence (on change, heartbeat 20 s)
  → in a sync: GET /v1/rooms/:id/phrases?after=seq  → teammates' lines → store mergeLines → pipeline + session
  → popup open or in a sync: GET /v1/rooms (rooms + presence) → core/room-picker rankRooms / inviteRoster / mergeCandidate
  → TeamsView back: prompt (Join "Alice, Bob" / Start new / Other syncs / Join by code), room, roster, merge, errors
Popup click → window.bee.teams.act({ type: "joinSync" | "startSync" | … }) → relay POST /v1/rooms[/join]
Mic phrase → store.simulateLine(text, "mic") → pipeline, and window.bee.teams.publish → shouldShare gate → POST phrases
  → relay stamps speakerId / speakerName from the verified Clerk JWT, serverTs, clamps spokenAt
Teams leaves the call (15 s) → controller leaves the sync; next detection → new popup, never an automatic rejoin
```

- **Relay** (`relay/src` + `convex/`): `handler.ts` routes HTTP to `state.ts` over a string key-value store. Production (`convex/http.ts`) verifies Clerk JWKS then runs `relay.dispatch` against a Convex `kv` table; `memory.ts` runs the same handler over a `Map` for tests and `npm run relay:mock`. `jwt.ts` checks RS256 against the Clerk JWKS (cached 10 min), then `iss`, `exp`, `nbf` and optionally `azp`. Unauthenticated or bad tokens get 401.
- **State**: `team:<id>`, `invite:<code>`, `user:<userId>` (membership, persisted); `presence:<teamId>`, `rooms:<teamId>`, `room:<id>`, `roomcode:<teamId>:<code>`, `phrases:<roomId>` (ephemeral). Rooms close when empty or after 4 hours; members that stop polling for 60 s are dropped; phrases are deleted with the room.
- **Room ids** are `crypto.randomUUID()`. Word codes are two random words, unique within the team while the room is open.
- **Ranking** (`core/room-picker.ts`): invited rooms (newest first), then rooms started within ±10 min of my detection with a member whose presence says "in a meeting" and is under 60 s old (closest first), then the rest. Only the first two tiers can be the one-click default.
- **Merge**: another room started within 30 s of mine by a teammate in a meeting. Each room votes (`POST …/merge`); when both have voted, the later room's members move to the earlier room and the later room is marked `mergedInto`.
- **Clocks**: every relay response carries `serverNow`. The client keeps the lowest-round-trip offset of the last 8 calls. It publishes `spokenAt` in server time and converts teammates' phrases back to its own clock, so lines merge in spoken order.
- **Share gate** (`core/sync-lines.ts shouldShare`): mic phrases only, only in a sync the user joined, never while **Pause sharing** is on. Teams' own mute is not readable without the Teams local API, so it is not used.
- **Fail-open**: relay errors never throw into the UI. Unreachable, 401 or 5xx shows "Bee is working solo" and the local pipeline carries on; 403/404 on a room ends the sync locally.
- **Main holds the relay connection**, so the renderer CSP stays closed to the relay host. The renderer passes a fresh Clerk token with each call; main checks it with `assertSignedIn` and the relay verifies it properly.
- **Window**: a third size, `prompt` (440 × 330), shows the notch and the sync card without the panel.
- **Deep links**: `bee://team/XXXX-XXXX` in `argv` (first launch, `second-instance`) or `open-url` (macOS) fills the invite code in **Settings → Team**. The user still clicks **Join team**.

## Processes and security

- The window is frameless, transparent, always on top and skipped from the taskbar. It sits at the top centre of the primary display's work area. It resizes between 440 × 64 px (collapsed), 440 × 330 px (notch and Teams sync card) and 480 × 640 px (expanded).
- The renderer runs with `sandbox: true`, `contextIsolation: true` and no Node integration.
- The renderer is served from `bee://renderer/` by `protocol.handle` (`main/renderer-protocol.ts`), not `file://`, so Clerk sees a stable origin. In development the handler proxies to the Vite dev server. Paths outside `out/renderer` return 404.
- The same handler sends the content security policy as a response header. Fonts are bundled (Instrument Sans woff2 in `renderer/src/fonts`), so `default-src 'self'` covers them and no font hosts are allowed. Remote scripts are allowed only from the Clerk Frontend API host (derived from the publishable key: `clerk.vedantb.com`) and `challenges.cloudflare.com` (bot protection). Images are allowed from `img.clerk.com`.
- Links opened from the renderer are denied; `https://` links (Clerk terms, help) open in the system browser.
- Only the `media` permission (microphone) is granted.
- All IPC input is validated with zod in main. All IPC output is validated with zod in preload.
- Secrets are encrypted with `safeStorage` before they are written. If encryption is unavailable, they stay in memory for the session.

## Authentication

Bee uses `@clerk/electron` against the vedantb.com Clerk production instance (`shared/clerk.ts`; `VITE_CLERK_PUBLISHABLE_KEY` overrides the key at build time).

- **Main:** `createClerkBridge` runs before `app.whenReady()`. It registers the `bee` scheme as privileged, owns Clerk's token-cache and OAuth IPC, and takes the single-instance lock on Windows and Linux. Bee stops booting when `isPrimaryInstance` is false. Tokens persist via `@clerk/electron/storage` (`electron-store` + `safeStorage`; not persisted without OS encryption).
- **Preload:** `exposeClerkBridge()` alongside `window.bee`.
- **Renderer:** `ClerkProvider` from `@clerk/electron/react`. Signed out, the panel shows `<SignIn>`; signed in, it shows the Bee panel with a `<UserButton>`. The microphone button shows only when signed in.
- **Pipeline gate:** the renderer sends `getToken()` with each run. Main checks the token's issuer (`https://clerk.vedantb.com`), subject and expiry. The signature is not verified: this is a sign-in gate, not a security boundary, since the pipeline only uses the user's own key and notes.
- **OAuth:** the system browser returns through `bee://renderer/`. electron-builder registers the `bee` scheme (`build.protocols`, plus the Linux MIME type).
- **Dashboard:** Native API must be enabled, and `bee://renderer` / `bee://renderer/*` allowlisted as redirect URLs.

## AI calls

All model calls use the Vercel AI SDK (`ai`, `@ai-sdk/gateway`) against Vercel AI Gateway. Every call sends `providerOptions: { gateway: { serviceTier: "flex" } }`. No sampling parameters are sent (no temperature, topP, presencePenalty or frequencyPenalty).

| Step | Model | API | Timeout | Retries |
| --- | --- | --- | --- | --- |
| Transcribe | `xai/grok-stt` | `experimental_transcribe` (Gateway transcription API) | 20 s | 1 |
| Rank | `typesafe-ai/jev` | `experimental_evaluate` (Gateway evaluation API) | 15 s | 1 |
| Guide | `openai/gpt-6-luna` | `generateText`, reasoning effort `low`, max 800 output tokens | 30 s | 1 |
| Summarise | `openai/gpt-6-luna` | `generateText`, reasoning effort `low`, max 2,000 output tokens | 60 s | 1 |

### Why Jev does not use chat completions

The brief asked for Jev via the OpenAI-compatible `/v1/chat/completions` endpoint. On 26 September 2026 the Gateway rejected that call with `ModelTypeMismatchError`: "Model 'typesafe-ai/jev' is an evaluation model, not a language model. Use the evaluation generation API instead." The Gateway model list gives Jev `"type": "evaluation"`. Bee therefore calls Jev through the AI SDK evaluation API. To keep one client, Luna uses the same SDK.

### Jev prompt format

Defined in `src/core/jev.ts`.

- **State:** `{ transcript }`, the recent meeting lines joined by newlines, oldest first.
- **Questions:** one `score` question per candidate, keyed `c0`, `c1`, … in retrieval order. Each question's instructions carry the task, the note title and the note text:

  ```json
  {
    "type": "score",
    "instructions": {
      "task": "Rate how relevant this note is to what the meeting is discussing right now.",
      "noteTitle": "Acme renewal › Pricing",
      "noteText": "…"
    },
    "criteria": [
      "Irrelevant: unrelated to what is being discussed.",
      "Loosely related: same broad area, but not useful right now.",
      "Relevant: useful background for the current topic.",
      "Directly useful: answers or informs what is being discussed right now."
    ]
  }
  ```

- **Answer:** Jev returns a fractional score from 0 to 3 per question.
- **Ordering:** highest score first, with ties kept in retrieval order. Missing, wrong-type or out-of-range answers go last, in retrieval order.
- **Filter:** notes scoring below 1 (`JEV_MIN_SCORE`) are not sent to Luna. They still show in the panel.
- **Fail-open:** if the call throws, times out or returns no usable score, Bee keeps the retrieval order and reports `Jev ranking failed: <reason>` in the panel.

Question keys are positional (`c0`…) rather than note ids. Note ids contain characters such as `#` and `.`, and positional keys keep the mapping simple.

### Luna prompt format

Defined in `src/core/luna.ts`. The system prompt asks for at most two tips, one per line, under 20 words each. If the latest lines ask a direct question, the first tip answers it: from the notes when they cover it (cited as `[n1]`), otherwise from general knowledge, with a brief caveat when the answer may have changed since training. Otherwise tips suggest what to say next, citing notes. Tips must not invent facts about the user's own work. If there is nothing useful, the model replies `NONE`. The user prompt holds the last 8 transcript lines and the notes labelled `[n1]`… The panel shows the same labels next to each note.

### Summary prompt format

Defined in `src/core/summary.ts`. The system prompt asks for exactly three `##` sections (Decisions, Action items, Topics) of short bullets, action items as `- Owner: task` when an owner is named, `- None recorded.` for an empty section, and no facts beyond the transcript and notes. The user prompt holds the session transcript and the titles of the notes cited. `parseSummaryMarkdown` drops code fences, titles and preamble, and rejects a reply missing any section.

## Hard-coded values

| Value | Where | Setting |
| --- | --- | --- |
| Retrieval candidates | `core/pipeline.ts` | 5 |
| Notes sent to Luna | `core/pipeline.ts` | 3 |
| Jev minimum score | `core/jev.ts` | 1 (on a 0–3 scale) |
| Transcript lines kept / per run | `renderer/src/store.ts`, `core/luna.ts` | 8 |
| Session lines kept for the summary | `shared/ipc.ts` | 200 |
| Notes cited / tips kept for the summary | `renderer/src/store.ts` | 100 each |
| Summary timeout | `core/summary.ts` | 60 s |
| Retrieval query window | `core/retrieve.ts` | last 3 lines, latest counted twice |
| BM25 k1 / b / title weight | `core/retrieve.ts` | 1.2 / 0.75 / 2 (standard defaults, not tuned) |
| Snippet length | `core/notes.ts` | 600 characters |
| Speech threshold (RMS) | `renderer/src/speech.ts` | 0.01, about −40 dBFS (not tuned) |
| Phrase pre-roll / end silence / minimum speech / maximum | `renderer/src/speech.ts` | 300 ms / 800 ms / 300 ms / 15 s |
| STT audio format | `renderer/src/speech.ts` | 16 kHz 16-bit mono WAV |
| STT upload cap | `shared/ipc.ts` | 2 MB |
| STT timeout | `core/transcribe.ts` | 20 s |
| Update check / download timeout | `main/updater.ts` | 10 s / 10 min |
| Clerk publishable key (fallback) | `shared/clerk.ts` | vedantb.com production instance |
| Teams detection stable / leave debounce | `core/meeting-tracker.ts` | 10 s / 15 s |
| Teams detector poll (minimum) | `main/teams-detector.ts` | 3 s |
| Sync tick | `renderer/src/store.ts` | 2 s |
| Presence heartbeat / stale | `core/sync-controller.ts`, `core/room-picker.ts` | 20 s / 60 s |
| Recent-room window / merge window | `core/room-picker.ts` | ±10 min / 30 s |
| Room hard limit / stale member / phrases kept | `relay/src/state.ts` | 4 h / 60 s / 400 per room |
| Spoken-at clamp | `relay/src/state.ts` | up to 30 s before the relay receives it |
| Relay request timeout / JWKS cache | `core/relay-client.ts`, `relay/src/jwt.ts` | 8 s / 10 min |

## Renderer state

One small external store (`renderer/src/store.ts`, read with `useSyncExternalStore`) holds settings, the active tab, the meeting session (not rendered), the last result, the summary state, the microphone state, the update state and the Teams view from main. A `setInterval` outside React drives the 2 s sync tick. Forms are uncontrolled and read with `FormData` on submit. There is no `useEffect`. The React Compiler is enabled.

Saved secrets show as a disabled field reading `•••••••• (saved)` with **Replace**. The form remounts after a successful save, so typed secrets clear and saved fields go back to masked.

## UI

- Font: Instrument Sans (variable, 400–700), self-hosted woff2 with the SIL OFL licence alongside.
- Icons: `@tabler/icons-react` (bundled into the renderer; unused icons are tree-shaken).
- Motion: CSS only, 150–220 ms, transform and opacity. Panel slides in on expand and fades out before the window shrinks (`COLLAPSE_MS` 160 in the store matches the CSS). Tabs, notch status, tips and notes fade or rise in. `prefers-reduced-motion` turns motion off.

## Not yet built

System audio capture and the vmem connector.
