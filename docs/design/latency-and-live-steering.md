# Latency and live steering (draft)

**Status:** draft for discussion. No code changed.
**Date:** 17 October 2026.
**Authorship:** Claude Code produced the first draft by reading the Bee repo at branch `cursor/latency-live-steering-design-1f1a` (HEAD `e09dfee`, Bee 0.3.6). A reviewer then checked claims against the same files and amended section 6 with current Vercel AI Gateway docs (realtime WebSocket and TTS exist). Nothing was run: the environment has no Electron display, mic or Gateway key. Latency figures remain ESTIMATE unless labelled otherwise.

**How to read the numbers.** Every latency figure below is either:

- **MEASURED**: a number that appears in the repo (code comment, constant, test). There are very few.
- **CONSTANT**: a timeout or threshold set in code. It is a ceiling or a fixed delay, not an observed latency.
- **ESTIMATE**: reasoned from the code path and general knowledge of these services. It is not from Bee traces. Treat it as a hypothesis to test in Phase 0.

Facts about ChatGPT voice, Gemini Live and Grok Bot come from general knowledge. Vercel AI Gateway realtime and TTS facts in section 6 were checked against Vercel docs (`gateway.experimental_realtime`, `openai/gpt-realtime-2`, speech-model / `openai/tts-1`, service tiers `flex` / `priority` / `ultrafast`). Verify prices and product behaviour again before a decision.

---

## 1. Current pipeline (as-built)

```
 user speaks
   │
 [1] renderer/src/mic.ts          getUserMedia (AEC + NS) → ScriptProcessorNode, 4096-sample frames (~85 ms at 48 kHz)
   │ onFrame
 [2] renderer/src/speech.ts       createSegmenter.push(): RMS ≥ 0.01 = speech; 300 ms pre-roll;
   │                              phrase ends after END_SILENCE_MS=800 of silence (or MAX_PHRASE_MS=15 s);
   │                              drops phrases with < MIN_SPEECH_MS=300 of speech
 [3] startMicSession.onPhrase     queue = queue.then(send)  → phrases transcribed ONE AT A TIME
   │                              encodeWav (16 kHz, 16-bit mono) on the renderer thread
 [4] window.bee.transcribe        preload → IPC bee:transcribe (≤ 2 MB), after `await sessionToken()` (Clerk)
   │
 [5] main/meeting-ipc.ts          assertSignedIn → createBeeGateway(key).transcription("xai/grok-stt")
   │                              (a new Gateway client per IPC call; no connection reuse)
   │   core/transcribe.ts         experimental_transcribe, batch, STT_TIMEOUT_MS=20 s, maxRetries 1, serviceTier flex
   │ text (or null → stop)
 [6] store.simulateLine(text,"mic")   addLines → startTurn (link chips, enrichChips in parallel) → runPipeline()
   │   store.runPipeline          latestRun++; set busy:true → island phase "thinking", pill "Thinking…"
   │                              await sessionToken(); window.bee.runPipeline({transcript: last 8 lines})
 [7] main/meeting-ipc.ts          loadSnippets(notesDir): readdirSync + readFileSync + chunk ALL notes, every run
   │   core/pipeline.ts           runPipeline():
 [8]   retrieve()                   BM25 over snippets, top 5 (sync, CPU)                        → timingsMs.retrieve
 [9]   rankWithJev()                experimental_evaluate, 15 s timeout, flex; skipped if 0 candidates   → timingsMs.rank
 [10]  loadMcp()                    loadMcpTools(): connect to every server in parallel, listTools, wrap  (AFTER Jev, BEFORE Luna)
 [11]  guideWithLuna()              generateText (not streamText), openai/gpt-6-luna, reasoningEffort low,
   │                                maxOutputTokens 800, stopWhen isStepCount(8), tools = web_search + fs + MCP,
   │                                LUNA_TIMEOUT_MS=45 s, flex                                      → timingsMs.guide
   │                                .finally(() => mcp.close())  – every connection (and stdio child) closes
 [12] PipelineResult returns once, whole (tips, sources, notes, timingsMs)
   │
 [13] store.runPipeline           if (run !== latestRun) return  (superseded results are dropped)
   │                              set result, busy:false; addToSession; touchIsland
 [14] App.tsx IslandBody          tips fade/slide in (not streamed). While busy: `result={state.busy ? null : result}`
```

Side paths:

- **Activity label.** `guideWithLuna` calls `onActivity` from `onToolExecutionStart` and `onStepFinish`. Main sends `bee:luna:activity`. The pill shows `activityLabel(tool)`. Before the first tool call it reads "Thinking…" (`island.ts`).
- **Link chips.** `startTurn` runs `enrichChips` (Jev plus vmem, 2.5 s budget, `ENRICH_TIMEOUT_MS` in `core/link-rank.ts`) in parallel with the pipeline. Chips can open the island body while Luna is busy (`islandShowsBody`). So chips can give early visual feedback, but only when the line contains a link.
- **Teams.** Mic phrases are also published with `shareLine` (fire and forget). It does not block the pipeline.
- **Superseded runs are not cancelled.** `latestRun` only discards the result in the renderer. No abort signal crosses IPC, so a superseded run keeps running in main: Jev, MCP connect, Luna and every tool call, up to 45 s. Fast speech therefore starts overlapping pipelines that each pay for Jev, MCP connections and Luna.
- **No TTS.** Confirmed: a search of `src/` and the README finds no text-to-speech, `speechSynthesis` or voice output. Bee is silent. Section 4 treats TTS as future only.
- **Stale docs.** `ARCHITECTURE.md` says Luna runs "up to 5 steps"; `core/luna.ts` has `MAX_STEPS = 8`. It also gives the enrichment budget as 2 s and the vmem call limit as 1 s; the code has `ENRICH_TIMEOUT_MS = 2500` and `VMEM_CALL_TIMEOUT_MS = 1500`.
- **Existing timing data.** `PipelineResult.timingsMs` has `retrieve`, `rank` and `guide`. The only consumer is the Notes badge in the full panel (`App.tsx`), which shows `rank + guide` in ms. It is not logged, not persisted, and there is no timing for STT, VAD, MCP load, TTFT or end-to-end. `t2` is taken before `loadMcp`, so `timingsMs.guide` is MCP connect, list and close plus Luna. MCP time is hidden inside `guide`.

---

## 2. Where time goes

Reference moment: the user stops speaking. All values in seconds unless stated. Everything marked ESTIMATE needs Phase 0 traces. Values are for a typical turn with notes on disk, one or two MCP servers connected, and a Gateway key.

| # | Stage | Code | What happens | Low / typical / high | Type | Confidence | Blocks "thinking"? |
|---|---|---|---|---|---|---|---|
| 1 | Frame granularity | `mic.ts` `FRAME_SAMPLES=4096` | VAD only sees whole frames | 0 / 0.04 / 0.085 s | CONSTANT (derived: 4096/48 kHz) | High | Before thinking starts |
| 2 | End-of-speech silence | `speech.ts` `END_SILENCE_MS=800` | Phrase closes only after 800 ms of quiet | 0.8 / 0.8 / 0.8 s (plus ≤ 0.085 s) | CONSTANT | High | Before thinking starts. Bee shows nothing here: the pill still says "Listening…" |
| 3 | Encode + IPC | `encodeWav`, `window.bee.transcribe`, `sessionToken()` | O(n) downsample on renderer thread; ≤ 2 MB structured clone; Clerk token | 0.01 / 0.03 / 0.1 s | ESTIMATE | Medium | Before thinking |
| 4 | STT queue wait | `startMicSession` `queue.then` | A phrase waits for earlier phrases' STT | 0 / 0 / one full STT call (1–3 s) | ESTIMATE | Medium | Before thinking. Matters when the user talks in bursts |
| 5 | STT call | `transcribe.ts`, `xai/grok-stt`, batch, flex | Upload (~32 KB per s of audio), transcribe, return whole text. Timeout 20 s, one retry | 0.5 / 1.2 / 3 s (a retry adds the failed attempt) | ESTIMATE | Low–medium (batch, flex tier, Gateway hop) | Before thinking |
| 6 | Pipeline kickoff | `store.runPipeline`, `sessionToken()`, IPC | `busy` set; second Clerk call; zod parse in main | 0.01 / 0.03 / 0.1 s | ESTIMATE | Medium | "Thinking" starts here |
| 7 | Snippet load | `main/notes.ts loadSnippets` | Synchronous read and chunk of every `.md`, per run, on the main-process event loop | 0.002 / 0.02 / 0.5 s (scales with folder size) | ESTIMATE | Low (depends on the user's notes) | Yes. Also blocks main's other IPC while it runs |
| 8 | Retrieve | `retrieve.ts` BM25 | Tokenises every snippet per run; top 5 | 0.001 / 0.01 / 0.1 s | ESTIMATE | Medium | Yes |
| 9 | Jev rank | `jev.ts` `experimental_evaluate`, 15 s timeout, flex, retry 1 | One Gateway evaluation call, 5 questions. Sequential before Luna. Zero if no candidates | 0 (no candidates) / 0.8 / 3 s (15 s on timeout, then fail open) | ESTIMATE | Low | Yes, and Luna waits for it |
| 10 | MCP connect + list | `mcp.ts loadMcpTools` → `connectMcp` | Per server, in parallel: transport connect, MCP `initialize`, `listTools` (paged). Streamable HTTP with OAuth may add a token refresh. Stdio spawns a process. Runs every turn. Slowest server sets the time. 10 s timeout each for connect and list | 0 (none enabled) / 0.5–1 / 3 s (10 s+ if a server hangs, 2 stages) | ESTIMATE. One MEASURED anchor: a tool call on an already-open vmem connection took 450–790 ms (comment in `core/vmem-history.ts`). That is a call, not connect. | Low | Yes, and Luna waits for it |
| 11 | Prompt build | `luna.ts buildLunaPrompt`, `lunaTools` | String concat; `sanitizeMcpSchema` per tool; SDK converts every tool to JSON schema. Large tool sets add input tokens (up to 100 tools × 20 servers allowed by `MCP_MAX_TOOLS` / limits) | < 0.01 s CPU, but input tokens grow with tools | ESTIMATE | Medium for CPU; the token cost shows up in stage 12 | Yes |
| 12 | Luna time to first token | `luna.ts generateText`, `openai/gpt-6-luna`, `reasoningEffort: "low"`, flex | Prefill of system (~350 tokens), transcript, 3 notes (up to 600 chars each), tool schemas; then hidden reasoning tokens; then output. Nothing is surfaced until the whole call ends | 0.8 / 2 / 5 s (no tool call) | ESTIMATE. Model `gpt-6-luna` is not known to this analysis; flex tier is documented in `gateway.ts` as "cheaper, may be slower" | Low | Yes |
| 13 | Luna generation | same | ≤ 2 tips, each < 20 words ≈ 25–50 output tokens | 0.3 / 0.6 / 1.5 s | ESTIMATE | Medium | Yes (non-streaming: user sees none of it) |
| 14 | Tool round trips | `luna.ts` loop `MAX_STEPS=8`; AI SDK executes tool calls in a step, then a new model call | Each step = one more full model call (prefill again) plus the tool. `web_search` runs provider-side (`searchContextSize: "low"`). MCP calls: 15 s each (`MCP_CALL_TIMEOUT_MS`). The SDK runs the calls of one step in parallel; multiple steps are sequential by nature | 0 (no tools) / 3–6 s per tool step / 15–45 s (hits the 45 s ceiling) | ESTIMATE | Low | Yes |
| 15 | MCP close | `loadMcp`… `.finally(() => mcp?.close())` | Awaited before the result returns. `CLOSE_TIMEOUT_MS` 3 s per connection, in parallel. HTTP close is usually fast; a stuck stdio child is not | 0.01 / 0.1 / 3 s | ESTIMATE | Low | **Yes**: the result waits for close because `.finally` is awaited inside the `await guideWithLuna(...)` chain |
| 16 | Return + render | IPC return, zod parse in preload, `set`, `applyWindowSize`, CSS fade (150–220 ms) | Result appears whole | 0.05 / 0.2 / 0.4 s | ESTIMATE (CSS motion is documented) | Medium | End of thinking |
| 17 | TTS start | none | Not built | N/A | n/a | n/a | n/a |

### Totals (ESTIMATE, not measured)

| Scenario | Silence → tips | Notes |
|---|---|---|
| No MCP servers, no tool call, notes match | about 4–8 s | 0.8 VAD + 1.2 STT + 0.8 Jev + 2–3 Luna + 0.3 overhead |
| One or two MCP servers connected, no tool call | about 5–10 s | adds the MCP connect/list stage (stage 10) and close (stage 15) on every turn |
| `web_search` or an MCP data tool used | about 10–30 s | each tool step re-runs a model call |
| Any provider hang | up to 15 s (Jev) + 10 s (MCP connect) + 10 s (list) + 45 s (Luna) | all CONSTANT ceilings; they fail open but the user waits |

Visible symptom: the user has about 2–3 s of "Listening…" with no acknowledgement (stages 1–5), then "Thinking…" for the remaining 3–7 s with nothing on screen.

### Call-outs

- **Flex tier everywhere.** `FLEX_PROVIDER_OPTIONS` (`gateway.ts`) is applied to STT, Jev and Luna alike. All three sit on the user-facing path. Flex is the cheaper, "may be slower" tier by Bee's own comment. Gateway also offers `priority` and `ultrafast` (see [service tiers](https://vercel.com/docs/ai-gateway/models-and-providers/service-tiers)). A flex request may queue before it runs. The size of that queue is unknown. Switching the user-facing path off flex (or onto `ultrafast` if the model supports it) is the cheapest hypothesis to test (section 7, Phase 0).
- **Non-streaming `generateText`.** Luna's whole latency, including hidden reasoning tokens and any tool loop, is paid before the first visible character.
- **MCP connect/list/close every turn.** `loadMcpTools` is called per run from `registerMeetingIpc`, and `mcp.close()` runs at the end. A connection is rebuilt for each spoken line even if the line needs no connected tool. Meanwhile `createVmemSearch` shows the repo already has a keep-warm pattern for link chips.
- **Jev before Luna.** `rankWithJev` has no data dependency on `loadMcp`. They run in series (`pipeline.ts`: `await rankWithJev` then `await loadMcp`). Overlapping them costs nothing.
- **800 ms VAD and sequential STT.** The VAD is a fixed floor on every turn. The STT queue means a second phrase cannot start transcribing until the first finishes.
- **Nothing is shown at end of speech.** The first on-screen change is `busy: true`, which happens after STT. The user cannot tell whether Bee heard them.

---

## 3. Why Grok Bot feels instant

Grok Bot internals are not public to this analysis. The following is a reasoned contrast, labelled as inference.

| Factor | Grok Bot (inference) | Bee today (code) |
|---|---|---|
| Acknowledgement | Responds or shows partial state almost at once | Silent until `busy` is set, then a generic "Thinking…" pill |
| Streaming | Tokens appear as generated, so time to first token is the felt latency | `generateText`: the first visible character arrives with the last |
| Tool setup | Tools and schemas are server-side and pre-registered; no per-turn connect | `connectMcp` + `listTools` per turn, then `close()` |
| Ranking model in front | Likely none; one model call | Jev call must finish before Luna starts |
| End-of-speech detection | Likely a streaming or server-side endpointer, or push-to-talk | Fixed 800 ms silence, then a batch STT call |
| Tier | Probably standard or priority | Flex on every call |
| Output size | Free-form chat; the user reads as it streams | ≤ 2 tips, < 20 words, which are short enough that the reading time after first token is under a second |

Two honest caveats:

1. Bee's answer is tiny (about 40 output tokens), so streaming the visible text saves less than it does in a chat product. The big wins are removing serial stages and giving the user feedback in the first second. Section 4 ranks accordingly.
2. Bee's job differs: it grounds tips in notes and tools, and says nothing when there is nothing useful (`NONE`). A fast chat reply to every line would be a different product.

---

## 4. Speed recommendations (ranked)

Impact is the ESTIMATE of perceived or actual latency removed on a typical turn. Effort: S (hours), M (a day or two), L (a week or more of focused work). No calendar promises.

| Rank | Change | Impact | Effort | Files / functions | Risks |
|---|---|---|---|---|---|
| 1 | **Instrument first**: log per-stage timings (VAD end, STT, load snippets, Jev, MCP load, Luna TTFT, tool steps, close, render) | Enables everything else | S | `speech.ts`, `transcribe.ts`, `pipeline.ts`, `luna.ts`, `store.ts` | Logs must carry no transcript text (UK GDPR minimisation, org rules) |
| 2 | **Run MCP load in parallel with Jev, and stop awaiting close before returning** | −0.5 to −3 s | S | `pipeline.ts` | Early MCP connect wasted when there are no candidates and Luna skips tools. Small |
| 3 | **Instant acknowledgement at end of speech**, before STT returns | Biggest perceived gain | S | `speech.ts` (new `onSpeechEnd`), `store.ts`, `App.tsx notchStatus` | Show state, not words. Do not show "Heard you" for a cough |
| 4 | **Cache MCP tool lists and connect lazily** (tool defs from cache, connection opens on first call) | −0.5 to −3 s on turns that need no MCP tool, i.e. most | M | `core/mcp.ts`, `pipeline.ts`, `main/mcp-ipc.ts`, `main/meeting-ipc.ts` | Stale schemas; cache invalidation on save/enable/sign-in; stdio lifecycle |
| 5 | **Test and probably drop flex for STT and Luna** (keep for summary, link Jev). A/B default vs `ultrafast` if the models support it | −0.3 to −3 s (unknown) | S | `gateway.ts`, `transcribe.ts`, `luna.ts` | Cost goes up. Needs Phase 0 A/B numbers |
| 6 | **Stream Luna** (`streamText`) and show tips as lines complete | Removes 0.5–1.5 s of generation, plus makes hidden-reasoning delay visible as progress | M | `luna.ts`, `pipeline.ts`, `shared/ipc.ts`, `meeting-ipc.ts`, `preload`, `store.ts`, `App.tsx` | New IPC channel; `parseLunaTips` and `NONE` handling must work on partial text; markdown stripping per line |
| 7 | **Tier the turn (router)**: cheap local gate, then a fast pass without tools, escalate only when needed | −1 to −4 s on easy turns | M–L | new `core/route.ts`; `pipeline.ts`; `luna.ts` | Behaviour change: fewer or different tips. Needs an eval set |
| 8 | **Skip Jev as a blocker**: send top-3 BM25 notes to Luna straight away; keep Jev for the panel display only, or run it only when BM25 candidates are ambiguous | −0.5 to −3 s | S–M | `pipeline.ts`, `jev.ts` | Slightly noisier notes in the prompt; loses `JEV_MIN_SCORE` filter |
| 9 | **Abort superseded runs** (AbortController across IPC) | Saves cost and CPU; reduces tail latency under burst speech | M | `store.ts`, `shared/ipc.ts`, `meeting-ipc.ts`, `pipeline.ts`, `luna.ts` | Cancel must also close MCP and stdio children |
| 10 | **Cache snippets** (mtime-based) and BM25 index | −0.02 to −0.5 s; stops main-thread blocking | S | `main/notes.ts`, `meeting-ipc.ts` | Staleness when files change; use `mtimeMs` check |
| 11 | **Lower VAD silence** to 500–600 ms, adaptive | −0.2 to −0.3 s | S | `speech.ts` `END_SILENCE_MS` | Cuts a sentence at a pause, which creates two lines and two runs |
| 12 | **Prewarm** Gateway connection and MCP at mic-on | −0.1 to −0.5 s on the first turn | S | `store.toggleMic`, a new `bee:warm` IPC | Wasted work if no speech follows |
| 13 | **Streaming STT with partials and early endpoint** | −1 to −2 s | L | `transcribe.ts`, `speech.ts`, new IPC stream | Reverses a deliberate ARCHITECTURE decision; needs a streaming STT provider via the Gateway |
| 14 | **Speculative start on partial transcripts** | −1 to −2 s more, if 13 exists | L | `store.ts`, `pipeline.ts` | Wasted calls; depends on 9 and 13 |
| 15 | **Lower reasoning effort** (`low` → `minimal`/none where supported) | −0.3 to −1.5 s (unknown) | S | `luna.ts` `providerOptions` | Quality; model support unverified |
| 16 | **Streaming TTS by sentence** | N/A today | L, future | none | Only if voice output is wanted (section 6) |

### Verdicts on the items in the brief

| Item | Verdict |
|---|---|
| Stream tokens to the UI | **Yes, but not first.** Answers are short, so the gain is smaller than in chat. It matters most with reasoning and with live steering (section 5), which needs partial output anyway. Rank 6. |
| Router / fast model | **Yes, as a staged gate**, not a second full pipeline. Rank 7. Measure first. |
| Instant acknowledgement | **Yes. Highest perceived gain per hour.** Rank 3. |
| MCP cache | **Yes.** Rank 4. Also rank 2 for the cheap overlap. |
| Parallel tool calls | **Already partly there.** The AI SDK runs one step's tool calls concurrently, and `loadMcpTools` connects all servers in parallel (`Promise.all`). The remaining serial parts are across steps (inherent) and Jev → MCP → Luna (fix: rank 2). No separate work item. |
| Prewarm | **Yes, small.** Rank 12. Cheap once the MCP cache exists. |
| Reasoning effort | **Test, do not assume.** Already `low`. Try the lowest setting the model accepts in the Phase 0 A/B. Rank 15. |
| Streaming STT | **Not now.** Large and reverses a documented decision. Revisit after rank 1–9 and only if STT (stage 5) measures over about 1.5 s. |
| Speculative start | **No in v1.** Depends on streaming STT and run cancellation. |
| Streaming TTS | **N/A today.** Bee has no voice output. See section 6. |

### Notes per recommendation

**1. Instrument first.** Add a `perf` object alongside `timingsMs`: `speechEndAt`, `sttMs`, `loadNotesMs`, `jevMs`, `mcpMs` (split connect and list), `lunaFirstTokenMs` (needs streaming or `onStepStart` timing), `lunaTotalMs`, `toolStepMs[]`, `closeMs`, `renderAt`. Extend `pipelineResultSchema` in `shared/ipc.ts` and keep text out of the log. Fix `timingsMs.guide` so it excludes MCP load. Today the badge in `App.tsx` hides MCP time inside "guide".

**2. Overlap MCP with Jev; do not await close.** In `runPipeline` start `const mcpPromise = loadMcp(args.loadMcpTools)` before `rankWithJev` and `await` it after. Close in the background: return the result, then `void mcp.close()`. Keep `close` bounded by `CLOSE_TIMEOUT_MS`. Risk: when `args.gateway` is null or candidates are empty, start MCP only if Luna will run, as today. This is a few lines and removes one full serial stage.

**3. Instant acknowledgement.** Two layers:
   - *Local, zero network*: `createSegmenter` already knows when speech ends. Add an `onSpeechEnd` callback (fires when `silenceMs >= END_SILENCE_MS`, before `end()` hands the phrase to STT). The store sets `phase: "heard"` and the pill reads something like "Got it…" with a subtle pulse. It fires only when `speechMs >= MIN_SPEECH_MS`, so coughs do not flash.
   - *Earlier still*: show a "listening" ring while `voiced` and speech has lasted at least `MIN_SPEECH_MS`. The level meter already exists (`setMic({ level })`).
   This is a state, not text: the transcript is never shown today (`speech.ts` header). Keeping it that way avoids a privacy and design change.
   - *Tool-time ack*: while MCP or web tools run, `activityLabel` already helps ("Searching the web", "Using eva…"). With cached tool lists (rank 4) the label can appear at the model's tool-call start.

**4. Cache MCP tools; connect lazily.** The goal is to take connect, `initialize` and `listTools` off the critical path.
   - Keep a per-server cache `{ configHash, tools[] (name, description, sanitized inputSchema), fetchedAt }` in main memory, filled by `bee:mcp:test`, `bee:mcp:authorize` and the first successful `connectMcp`. `configHash` covers URL/command, args, auth type and whether secrets changed. `settings.ts` already stores tool names and descriptions per server (`tools: { name, description, enabled }[]`), but not schemas. The cache needs schemas.
   - `loadMcpTools` builds AI SDK tools from the cache immediately. Each tool's `execute` calls `ensureConnection(server)`, a shared lazy promise, then `connection.call(...)`. Turns that never call an MCP tool never connect.
   - Keep the connection warm for an idle period (for example 60 s, ESTIMATE of a sensible value) instead of closing per run. `core/vmem-history.ts createVmemSearch` is the in-repo precedent (warm connection, `refresh()` on settings change, drop on failure). Stdio children close on idle timeout and at quit.
   - Refresh the list in the background with a TTL (for example 10 min) and on any save, enable, disable or sign-in. If the model calls a tool the server no longer has, return `Error: …` text, as today.
   - Risk: the schema error recovery in `guideWithLuna` (`SCHEMA_ERROR`, `toolsToDrop`) still works on cached tools. Keep it.
   - Not safe to cache: OAuth tokens in the tool objects. Cache only definitions; auth stays in `authProvider` per connection.

**5. Flex tier.** Make the tier a per-call choice in `gateway.ts`: user-facing calls (STT, Luna turn) default or `ultrafast`; background calls (summary, link Jev) flex. Run the Phase 0 A/B (same transcript set: flex vs default vs ultrafast) to price the change before deciding. This is a one-line change per call and the most likely single cheap win. I do not know the Gateway's flex queueing in practice; treat the gain as unknown. Not every model accepts every tier — check `providerMetadata.gateway.serviceTier` on a real call.

**6. Stream Luna.** Switch `guideWithLuna` from `generateText` to `streamText`, keep the retry loop for schema errors (an error can surface on the first chunk or mid-stream; handle both). Emit line-level updates: accumulate `textStream`, split on `\n`, run `stripMarkdown` per completed line, and send `tipsSoFar` to the renderer over a new `bee:luna:partial` channel (zod schema in `shared/ipc.ts`, same pattern as `lunaActivitySchema`). Keep `parseLunaTips` as the final authority on completion (it handles `NONE` and the 2-tip cap). While streaming, hold back a first line until it has at least a few words or a newline, so `NONE` never flashes. Sources arrive at the end (`sourcesFromGenerateResult`); show them when the stream finishes. Tool-using runs often emit no text before the tool call, so streaming does not help those turns; ack and tool labels do.

**7. Router.** Do it in three layers and stop at the first that suffices:
   1. *Local gate (free).* Skip the pipeline for lines that are filler or acknowledgements with no content words: reuse `tokenize` from `retrieve.ts`; if `tokenize(line).length === 0` the line has only stopwords such as "okay", "yes", "um" (`STOPWORDS` already includes those). `"yeah"` is not in that set today, so add it if this gate ships. Today such a line still pays for Jev, MCP and Luna and ends in `NONE`. Wire this in `store.simulateLine` before `runPipeline`. The line still joins the transcript window.
   2. *Fast first pass.* A smaller model with no web search and no MCP tools answers from notes and the transcript, which covers "suggest what to say next" and note-grounded questions. The prompt tells it to reply `ESCALATE` when the question needs live data or the user's connected systems. Cheap signal for escalation: a question mark or interrogative start in the last line, plus a notes miss; and MCP keywords from cached tool names or descriptions (rank 4 gives these for free).
   3. *Escalate* to the current full Luna run with tools. The user already saw the ack and, from layer 2, possibly a first tip.
   Risk: this changes what Bee says. Needs a small eval set of real lines (from Vedant) with expected behaviour. Model choices are open (section 8). I do not know which fast models the Gateway offers at the time of writing; verify before choosing.

**8. Skip Jev as a blocker.** Jev improves ordering and filters below `JEV_MIN_SCORE`. Luna reads three notes anyway. Option A: send BM25 top 3 and let Luna ignore irrelevant ones. Option B: run Jev in parallel with Luna and only use it for the panel's note list and `jevScore` badge, never to gate Luna. Option B keeps the UI as is and the tips lose only the filter. Compare tip quality in the eval set before dropping the filter.

**9. Abort superseded runs.** Pass a `runId` and an `AbortSignal` through IPC: the renderer sends `bee:pipeline:cancel` with the run id when `latestRun` advances; main keeps `Map<runId, AbortController>`; `runPipeline` passes the signal to `rankWithJev`, `loadMcpTools` (close on abort) and `guideWithLuna` (combine with `AbortSignal.timeout` via `AbortSignal.any`). This is a prerequisite for live steering (section 5), so it belongs in Phase 2 or 3 even though its speed gain alone is modest.

**10. Cache snippets.** `loadSnippets` reads every note on every run. Cache `Snippet[]` keyed by file `mtimeMs` and size. Cheap and safe, and it stops blocking main's event loop, which also serves Teams ticks and IPC.

**11. VAD silence.** 800 ms is conservative. Lowering to about 600 ms saves 0.2 s. It also splits sentences at thinking pauses, which makes more lines and more runs. Better: keep 800 ms for the final phrase end, but use the ack (rank 3) and, later, partial transcripts (rank 13) so that the floor is not felt. Do not tune without trace data.

**12. Prewarm.** On `toggleMic`, trigger a `bee:warm` IPC that does a cheap Gateway request (to open the TLS connection in main's HTTP agent) and, once rank 4 exists, `ensureConnection` for enabled MCP servers. The first turn of a meeting then avoids cold TLS and OAuth refresh. Gain is real only on the first turn.

**13–14. Streaming STT and speculative start.** `ARCHITECTURE.md` records that `experimental_streamTranscribe` was deliberately not used: "Phrase-level batch calls are simpler, and one call per phrase matches one pipeline run per line." That reasoning still holds for v1. Revisit only if Phase 0 shows STT is a large share. Speculation also needs cancellation (rank 9) and a way to commit or discard a partial answer; it multiplies model spend. Not recommended before live steering exists, because partial transcripts are the same mechanism steering needs.

**15. Reasoning effort.** The call already sets `openai: { reasoningEffort: "low" }` (`luna.ts`). I cannot verify whether `gpt-6-luna` accepts a lower setting. Put it in the Phase 0 A/B matrix.

**16. TTS.** See section 6 and Phase 4.

---

## 5. Live steering design

### Goal

The user keeps talking while Bee answers. Bee shows output live. A new sentence mid-answer means Bee answers what was said before and what was said now. The earlier part is not lost.

### What exists today

- The mic stays on during `busy` (`toggleMic` is independent of `runPipeline`).
- Each new line calls `runPipeline`, which does `++latestRun` and drops the older result. The older run keeps burning resources in main (section 1).
- `islandShowsBody` hides the previous turn's tips while `busy` (comment in `island.ts`; `App.tsx` passes `result={state.busy ? null : result}`).
- Transcript window: last 8 lines (`PIPELINE_WINDOW` in `store.ts`, `TRANSCRIPT_WINDOW` in `luna.ts`).
- STT phrases are sequential. A 15 s phrase cap (`MAX_PHRASE_MS`) forces a cut mid-sentence.
- `startTurn` clears chips for each new line: `chips` is replaced, and `dismissedChipIds` reset.

So today a second sentence does not lose the first in the transcript (the prompt still contains both lines), but it wipes whatever the user could see and cancels the first answer's result. The user sees "Thinking…" again from zero.

### Merge strategies compared

| Strategy | How it works | Pros | Cons for Bee |
|---|---|---|---|
| A. **Cancel and restart with combined transcript plus partial answer** | Abort the in-flight run. Start a new run with all lines so far, plus the tips already shown, marked as "already shown" | Matches Bee's pipeline. One model call at a time. Answers both. Smallest change: `latestRun` and the transcript window already work this way | Wasted tokens for the cancelled call. Restart cost (a few seconds) after every sentence. The model may repeat or contradict the shown tips unless told |
| B. **Append as a follow-up user message** (chat continuation) | Keep the conversation; add a new user turn after the assistant's reply, or cancel and append | Natural chat model, KV-cache friendly, history is explicit | Bee has no chat state: each run is a fresh prompt over a transcript window and notes. Adds a multi-turn store and a new prompt format. Mid-answer arrival still needs cancel or queue. Not needed for tips |
| C. **True mid-stream steering** | Inject new input into the running generation | Lowest latency, most natural | Not supported by standard text-completion APIs through the Gateway. Needs a realtime session API (section 6). Large change |
| D. **Queue and run after** | Let the first finish, then run the second | Simple | The user waits for stale answers; the second answer is late; defeats "steering" |

### Recommendation: Strategy A, "cancel and re-answer with a keep list"

Choose A. It reuses what Bee already does (new line, new run, newest wins) and fixes the two actual faults: wasted work in main and wiped output on screen. B and C need chat or realtime state that Bee does not have. D is what users complain about.

**How it works**

1. **Run identity.** Each run has an id and an `AbortController` (rank 9). A new line aborts the active run, unless the run is in a "commit window" (below).
2. **Prompt.** The new run sends the whole transcript window plus a **shown tips** block:
   ```
   Already shown to the user (keep; do not repeat; refine only if the new line changes the answer):
   - <tip 1>
   - <tip 2>
   ```
   `buildLunaPrompt` gets an optional `shown: string[]`. The system prompt adds one rule: "If tips are already shown, add tips for new lines. Repeat or replace a shown tip only if the new line corrects it." For v1 the model returns the **full** set of tips for the current state and keeps earlier tips when they are still valid. The UI diffs by string equality (below). A delta format (new or replaced lines only) is a later option.
3. **Tips cap.** With steering, two tips can mean "answer to old question" and "answer to new question". v1 raises the visible cap from 2 to 3 during a steering burst (`MAX_TIPS` in `luna.ts`), then relaxes. Open question for Vedant (section 8).
4. **Partial output kept.** Streamed lines (rank 6) are written into a `live` list in the store. On abort, completed lines stay on screen. A half-finished line is dropped (never show a truncated sentence as a tip).
5. **Merge by identity.** The renderer keeps tips in a list with stable keys (the tip text as today, `App.tsx` uses `key={tip}`). When the new run emits a line equal to an existing tip (after trim and cite normalisation), it is a no-op, so nothing re-animates and nothing is wiped.
6. **Debounce.** Do not abort on every phrase. After a new line, wait a short window (ESTIMATE 400–600 ms) for another phrase to arrive, then start the new run. The VAD already adds 800 ms, so the user is usually done by then; the debounce mostly protects against the two-line burst caused by `MAX_PHRASE_MS` cuts and mid-sentence pauses.
7. **Commit window.** If the in-flight run already has its first tip complete and is on its second, do not abort. Let it finish, then start the new run with `shown` filled. This avoids killing an answer that is nearly done. ESTIMATE rule; tune with traces.
8. **Cap on restarts.** After 3 restarts within 10 s, wait until speech has paused for 1.5 s before the next run. This stops a rambling speaker from starving output.

### State machine (renderer store)

```
                 speech frames (voiced ≥ MIN_SPEECH_MS)
IDLE ───────────────────────────────────────────────────────────► LISTENING
 ▲                                                                   │ END_SILENCE_MS
 │ island idle 10 s (ISLAND_IDLE_MS)                                 ▼
 │                                                                HEARD (ack; STT in flight)
 │                                                                   │ text
 │                                                                   ▼
 │   run finished, no new speech                                 THINKING  (tools/label; shown tips stay visible)
 ├──────────────────────────────────────────────────────  ◄──── ▲   │ first complete tip
 │                                                                │   ▼
 │                                                                │ ANSWERING (streamed lines appear)
 │                                                                │   │ finished
 │                                                                │   ▼
 │                                                                └─ SETTLED (expanded, 10 s idle timer)
 │
 │  New speech at any point after THINKING:
 │      voiced ≥ MIN_SPEECH_MS  ─► LISTENING_OVER (shown tips stay; badge "Listening…"; run keeps going)
 │      line transcribed         ─► REVISING (abort or commit-window rule; new run; tips stay; pill "Updating…")
 │      → ANSWERING (diff-merge) → SETTLED
```

State to add in `store.ts`: `phase` (replacing the derived pair `busy` + `islandPhase`), `tips: { text, id, source: "kept" | "new" }[]`, `activeRunId`, `restartCount`. `islandPhase` in `island.ts` gains `"revising"`; `islandShowsBody` stops returning `false` while busy when there are kept tips. This reverses the current rule "never show previous turn's tips" (`App.tsx` and `island.ts` comments). Keep the intent of that rule: the problem it solved was an old answer passing for the new one. Mark kept tips as such during revising: dim them slightly and show "Updating…" in the pill. Clear them only at a new **turn**, defined as no speech for more than `TURN_GAP_MS` (ESTIMATE 8–10 s, aligned to `ISLAND_IDLE_MS`) or after the user dismisses the island. A tip from before a long gap is a previous turn and is hidden as today.

### What happens to each component

| Component | Behaviour on new speech mid-answer |
|---|---|
| **Displayed tips** | Stay. Dimmed and labelled while revising. Merge by text equality. Removed only on turn gap, dismissal or an explicit correction from the new run |
| **Link chips** | Today `startTurn` replaces chips per line. During a steering burst, merge instead (`mergeChips(state.chips, new)`), and keep the turn id (`turnSeq`) unchanged until a turn gap. Otherwise chips flicker and `enrichChips` results are dropped by the `seq !== turnSeq` check |
| **In-flight Luna** | Abort via `AbortSignal` unless in the commit window. Partial text already emitted (complete lines only) stays |
| **In-flight MCP** | Abort the signal. Reads can be abandoned safely. **Writes are the risk**: `append_note` (fs tool, local) and any MCP tool with side effects may have run or half-run. Rule: a tool call that has started is allowed to finish; the run stops issuing new tool calls (`stopWhen` check on abort) and its result is delivered to the new run as context ("Tool X already ran and returned Y"). Never abort a write mid-flight. With the lazy-connect cache (rank 4) the connection stays warm, so cancelling does not cost a reconnect |
| **Provider-side `web_search`** | It runs inside the provider's step and cannot be cancelled early. Drop the result if superseded. Its cost is sunk |
| **STT** | Keep the sequential queue in v1. It is ordering-safe: lines reach the store in spoken order. Mic stays open throughout. If a phrase is in flight, the new run starts from the previous lines plus the debounce, then restarts once more when that line lands. Do not run STT calls in parallel in v1: out-of-order lines would corrupt the transcript window |
| **TTS (future)** | See next section |
| **Teams sync** | Unchanged. `shareLine` still publishes each phrase. Teammates' lines arrive through `addLines` and follow the same steering rules (they restart or extend the current run) |
| **Summary / session** | `addToSession(result)` must run once per settled turn, not once per aborted run. Today every non-superseded result is added. With restarts, add on SETTLED only, and de-duplicate by tip text |

### Barge-in with TTS (future, Phase 4)

Bee has no voice output, so this is design for later. If TTS is added:

- Sentence-by-sentence streaming TTS fed by the streamed tip lines.
- When the VAD sees speech while TTS is playing, **duck then stop**: lower volume at once, stop at `MIN_SPEECH_MS`, keep the already-spoken sentences in the shown list. Resume is not offered; the new run covers it.
- Echo: `mic.ts` already requests `echoCancellation: true` and `noiseSuppression: true`. Whether Chromium AEC handles audio played by the same Electron renderer on each OS is unverified; it needs a test. The safe fallback is push-to-interrupt (a hotkey) or headphone detection.
- A meeting copilot must not speak into a live call. Default TTS off. Any TTS needs an output device choice that is not the call's output. Open question for Vedant.

### Edge cases

| Case | Handling |
|---|---|
| **Filler** ("um", "okay", "yeah") | Local gate (rank 7 layer 1): lines with no content tokens are added to the transcript but never abort a run and never start one. Also covers "uh-huh" and backchannel from the other party |
| **Speaking to someone else** (call audio, a colleague in the room) | No reliable way to know from audio alone. v1: do nothing special. The system prompt already says to answer only when the latest lines ask something and otherwise reply `NONE`. A new line addressed to another person starts a restart cycle that ends in `NONE`, and the shown tips stay (they are kept unless corrected). Optional later: a push-to-talk or "address Bee" key for steering only |
| **Own correction** ("no, I meant X") | The model sees both lines and shown tips and may replace one. Replaced tips animate out; others stay |
| **Very long speech** | `MAX_PHRASE_MS=15 s` cut mid-sentence creates two lines. The debounce (6 above) and the restart cap (8) protect against two restarts in a row |
| **STT failure on one phrase** | `onError` shows the message; the run in flight is unaffected. Do not abort for a phrase that never produced text |
| **Aborted run's late result** | Dropped by run id, as `latestRun` does today. Add the main-side abort so it also stops spending |
| **Teammate's line arrives mid-answer** | Same path as your own line. Label the pill "Updating…" |
| **User dismisses the island mid-answer** | Dismiss hides tips (`dismissed: true`) but keeps the run unless a new line aborts it. A new result reopens the body, as today |
| **Tool error mid-revision** | The `Error: …` string returns to the model as today; shown tips remain |
| **Two runs finish out of order** | Run id check; only the active run may write the store |

### What NOT to do in v1

- No true mid-stream steering, no realtime audio session.
- No parallel STT calls and no out-of-order line insertion.
- No new chat transcript UI. Keep the island as short tips. Show at most 3 tips and sources.
- No speculative runs on partial transcripts. They need streaming STT and the cancellation work first.
- No automatic TTS and no barge-in code until voice output exists.
- No aborting of tool calls that have already started, especially writes.
- No hiding of kept tips on a clock shorter than `ISLAND_IDLE_MS` without trace evidence.

---

## 6. Realtime speech-to-speech vs current stack

### Comparison (products are described from general knowledge; verify before relying)

| | Bee today: VAD → batch STT → Jev → Luna | OpenAI Realtime / ChatGPT voice | Gemini Live | Streaming STT + LLM + TTS pipeline |
|---|---|---|---|---|
| Shape | Text tips in an island | Speech-in, speech-out over a persistent session (WebRTC or WebSocket) | Same idea, Google's session API | Components you choose |
| Latency to first output | Seconds (section 2) | Typically sub-second to ~1 s to start speaking | Similar claim | About 1–2 s with care |
| Turn-taking | Fixed 800 ms silence | Server VAD or semantic VAD; built-in barge-in | Built-in barge-in | You build it |
| Mid-answer steering | Cancel and restart (section 5) | Native: new audio interrupts and the model continues the conversation | Native | You build it |
| Tool calls | AI SDK tools, MCP | Function calling in-session; MCP support is available in some Realtime offerings but not verified here | Function calling | Your own loop |
| Grounding in notes | BM25 + Jev + prompt | Must be sent in-session as context or via a tool | Same | Your own |
| Citations | `[n1]` cites, sources from `web_search` | Not a built-in concept; you must implement it | Google Search grounding in some modes | Your own |
| Cost model | Per call, flex | Audio tokens in and out for the whole session; pricing is audio-token-based and typically higher than text; not verified | Not verified | Mixed |
| Control of output text | Full (`parseLunaTips`, `NONE`) | Weaker: the model speaks | Weaker | Full |
| Meeting copilot fit | Good: silent, short | Poor: the product speaks, and Bee must stay quiet | Poor | Neutral |

**Gateway realtime exists.** Vercel AI Gateway documents `gateway.experimental_realtime.getToken({ model })` and a WebSocket session for `openai/gpt-realtime-2` (Node 22.18+, `@ai-sdk/gateway`). It also documents batch TTS (`experimental_generateSpeech` / `POST …/speech-model`, e.g. `openai/tts-1`) and batch STT. Bee already holds a Gateway key in main, so a realtime session would not need a second provider key. It would still send raw meeting audio for the life of the session, change billing (audio tokens), and sit outside the current `generateText` + MCP tool loop. Keep that as a separate product mode, not a drop-in for the island.

### Recommendation

**Keep STT → LLM for v1. Do not adopt a realtime speech-to-speech API now.**

Reasons:

1. **Product shape.** Bee is a meeting copilot overlay: it listens quietly, shows at most two short tips, cites notes and sources, and says `NONE` when there is nothing useful. A speech-to-speech model is built to converse. It speaks every turn, and making it silent is working against its design.
2. **Grounding and citations.** `[n1]` citations, `sourcesFromGenerateResult`, `JEV_MIN_SCORE` filtering and the `NONE` rule all depend on text output Bee controls.
3. **MCP and tools.** The MCP stack (OAuth providers, schema sanitising, per-tool disabling, error masking) is built on the AI SDK. A realtime session would need that rebuilt in a different tool-calling protocol.
4. **Audio privacy and Teams.** Bee's relay shares text lines between teammates and writes a text summary. A realtime session would send raw meeting audio to a model provider for the whole call and bills continuously. The system audio and meeting-room scenario makes this a bigger data-handling decision.
5. **The latency gap is mostly fixable inside the current stack.** Sections 2 and 4 show serial stages and the lack of an ack, not the model, as the main cost. Fixing them is much smaller than a rewrite and the brief rules a rewrite out.
6. **Cost.** Continuous audio sessions over a multi-hour meeting would cost more than phrase-level calls. I have no price data in the repo; this needs a quote calculation (open question).

**When to revisit:** if Vedant wants Bee to talk (a voice mode used outside calls, such as a solo planning assistant), a separate *voice mode* could use Gateway `openai/gpt-realtime-2` (or Gemini Live) as an opt-in with its own button, leaving the meeting copilot untouched. That is Phase 4 and optional. Batch TTS (`openai/tts-1` via Gateway) is a smaller add-on on top of streamed tips if he wants spoken tips without a full realtime session.

**Middle path, if the STT delay measures high:** keep text tips but swap the STT stage for provider streaming STT (rank 13). It addresses the speech-end delay without changing the output model. It also fits live steering, since partial transcripts arrive during speech.

**TTS today:** none. If voice output is wanted, add sentence-level streaming TTS fed by the streamed tip lines (rank 6 is the prerequisite). Keep it off by default in meetings.

---

## 7. Phased implementation plan

Sizes: S (small), M (medium), L (large). Not calendar time.

### Phase 0: Instrumentation (S)

Goal: replace ESTIMATEs with MEASURED numbers before changing behaviour.

- Per-stage timers across the path in section 2. Extend `PipelineResult.timingsMs` with `loadNotes`, `mcp` (connect and list split), `lunaFirstToken`, `tools[]`, `close`. Separate `guide` from MCP time.
- Renderer: stamp `speechEndAt` in `speech.ts`, `sttDoneAt` in `startMicSession.send`, `pipelineStartAt`, `resultAt`, `paintAt`. Compute end-to-end as `paintAt − speechEndAt`.
- Log to a local file or `console.debug` as numbers only, with no transcript or note text, no keys.
- A/B harness (extend `test/smoke.gateway.test.ts`, which needs a key): same 20 recorded lines, run flex vs default, `low` vs lowest reasoning, with and without Jev, with and without MCP. Output a table of p50 and p90.
- Document the real numbers in this file and delete the matching ESTIMATE labels.

### Phase 1: Quick wins (S–M)

Ranks 2, 5, 8 (option B), 10, and the local filler gate (rank 7 layer 1). No UI change, no new IPC.

- Overlap MCP with Jev; close in background.
- Flex off for STT and Luna if Phase 0 supports it.
- Jev non-blocking (or parallel).
- Snippet cache.
- Filler gate in `simulateLine`.
- Fix `ARCHITECTURE.md` table (steps 8, enrichment 2.5 s, vmem call 1.5 s).

### Phase 2: Perceived latency (M)

Ranks 3, 4, 6, 9, and "don't wipe".

- Ack at end of speech (`onSpeechEnd` → `HEARD`).
- MCP cache and lazy connect.
- `streamText` for Luna with `bee:luna:partial` channel; line-level rendering; `NONE` guard.
- Main-side cancellation with run ids.
- Island keeps shown tips during a new run (dimmed), with the turn-gap rule. Update `island.ts` tests (`island.test.ts`) and `App.tsx`.

### Phase 3: Live steering (M–L)

Strategy A from section 5.

- `shown` list in prompt and `buildLunaPrompt`; system rule for kept tips.
- State machine in `store.ts`: debounce, commit window, restart cap, chip merging, session de-duplication.
- Tool-safety rule for in-flight writes.
- Eval set: a dozen scripted multi-sentence scenarios (correction, add-on, filler, aside) run through `runPipeline` with a stub model, plus a Gateway run.
- E2E: extend `test/e2e` (mic harness exists) with a two-phrase burst.

### Phase 4: Optional realtime and TTS (L)

- Only if Vedant wants voice output or a separate voice mode.
- Sentence-level streaming TTS from the Phase 2 stream; barge-in with duck-and-stop; AEC verification per OS; default off during detected Teams calls.
- Separate evaluation of a realtime speech-to-speech session as an opt-in voice mode, after a Gateway capability check, cost model and a data-handling review. Not part of the meeting copilot path.
- Streaming STT with partial transcripts (rank 13) belongs here if Phase 0 shows STT dominates.

---

## 8. Open questions

For Vedant:

1. **Real latency story.** Which turns feel slowest: plain questions, ones that hit MCP (Eva, vmem), or web search? That decides whether Phase 1 or the router matters most.
2. **Which connectors are on in daily use**, and are they remote HTTP or stdio? Stdio spawn time can dominate.
3. **Tip cap during steering.** Is three tips acceptable in the island, or should steering replace rather than add?
4. **Should earlier tips ever stay on screen after a long pause?** The current rule hides the previous turn's tips. What gap counts as a new turn?
5. **Is silent-by-default important?** Does he want voice output, ever, and where (headphones only, not during Teams)?
6. **Is shorter silence endpointing acceptable** if it sometimes splits a sentence?
7. **Cost ceiling.** Is moving STT and Luna off flex acceptable if it raises spend? What is the monthly budget?
8. **Behaviour of non-questions.** Should Bee stay proactive ("suggest what to say next") on every line, or only on questions and notes hits? The router and filler gate change this.

Only production traces (Phase 0) can answer:

9. Flex vs standard latency and p90 for STT, Jev and Luna.
10. Time spent in MCP connect and list per server, and cold vs warm OAuth refresh.
11. How often Jev changes the top-3 notes, and whether Luna's tips differ without it.
12. How often fast speech creates overlapping runs, and the share of Luna spend on superseded runs.
13. STT share of total latency, and how often a second phrase waits in the sequential queue.
14. Whether `gpt-6-luna` accepts a lower reasoning setting, and how the latency changes.
15. Whether Chromium's echo cancellation holds when the same app plays TTS, on macOS and Windows.

Outside the repo, to verify before decisions:

16. Price and Electron/WebSocket fit of Gateway `openai/gpt-realtime-2` (`experimental_realtime`), and whether streaming transcription (partials) is available for `xai/grok-stt` without switching STT models. Realtime itself is documented; streaming Grok STT is not confirmed here.
17. The behaviour and price of OpenAI Realtime and Gemini Live on the dates of any decision. Section 6 describes them from general knowledge only.
18. Legal and security review is recommended before sending raw meeting audio to a new provider route, and for any change that records or plays back call audio (data protection, consent for other participants).

---

*Source files read for this document:* `ARCHITECTURE.md`, `README.md`, `src/core/{pipeline,luna,jev,transcribe,gateway,tools,mcp,retrieve,vmem-history}.ts`, `src/renderer/src/{mic,speech,store,island,App}.ts(x)`, `src/main/{meeting-ipc,link-ipc,notes}.ts`, `src/shared/ipc.ts`. No timings were measured in this environment.
