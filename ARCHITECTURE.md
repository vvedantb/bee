# Architecture

Bee is an Electron app built with electron-vite, React and TypeScript.

```
src/
  main/       Electron main process: notch window, tray, IPC, settings, notes folder, bee:// protocol, Clerk bridge
  preload/    Sandboxed bridge: exposes window.bee (parses every response with zod) and Clerk's bridge
  renderer/   React UI: collapsed notch, sign-in, expanded panel (Live, Settings), mic capture (mic.ts), phrase detection and WAV (speech.ts)
  shared/     IPC channel names and zod schemas, Clerk config (shared/clerk.ts)
  core/       Pure TypeScript: note chunking, retrieval, Jev ranking, Luna guidance, Grok STT, pipeline, release version checks
test/         Live Gateway smoke test (npm run test:gateway), Electron mic E2E (npm run test:e2e, harness in test/e2e)
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

The renderer keeps the last 8 lines (spoken or typed) and sends them with each run. The lines are not rendered: the Live tab shows tips and notes only. The main process holds no meeting state. Each run takes a number (`latestRun`); a result is shown only if no newer run has started, so fast speech never shows stale tips.

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

## Processes and security

- The window is frameless, transparent, always on top and skipped from the taskbar. It sits at the top centre of the primary display's work area. It resizes between 440 × 64 px (collapsed) and 480 × 640 px (expanded).
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

## Hard-coded values

| Value | Where | Setting |
| --- | --- | --- |
| Retrieval candidates | `core/pipeline.ts` | 5 |
| Notes sent to Luna | `core/pipeline.ts` | 3 |
| Jev minimum score | `core/jev.ts` | 1 (on a 0–3 scale) |
| Transcript lines kept / per run | `renderer/src/store.ts`, `core/luna.ts` | 8 |
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

## Renderer state

One small external store (`renderer/src/store.ts`, read with `useSyncExternalStore`) holds settings, the active tab, the recent meeting lines (not rendered), the last result, the microphone state and the update state. Forms are uncontrolled and read with `FormData` on submit. There is no `useEffect`. The React Compiler is enabled.

Saved secrets show as a disabled field reading `•••••••• (saved)` with **Replace**. The form remounts after a successful save, so typed secrets clear and saved fields go back to masked.

## UI

- Font: Instrument Sans (variable, 400–700), self-hosted woff2 with the SIL OFL licence alongside.
- Icons: `@tabler/icons-react` (bundled into the renderer; unused icons are tree-shaken).
- Motion: CSS only, 150–220 ms, transform and opacity. Panel slides in on expand and fades out before the window shrinks (`COLLAPSE_MS` 160 in the store matches the CSS). Tabs, notch status, tips and notes fade or rise in. `prefers-reduced-motion` turns motion off.

## Not yet built

System audio capture and the vmem connector.

## Future

- **Meeting summary export.** At the end of a meeting, write a markdown summary (decisions, owners, notes used) into the notes folder, so next week's "last time we discussed X" finds it. Not implemented.
