# Architecture

Bee is an Electron app built with electron-vite, React and TypeScript.

```
src/
  main/       Electron main process: notch window, tray, IPC, settings, notes folder
  preload/    Sandboxed bridge: exposes window.bee and parses every response with zod
  renderer/   React UI: collapsed notch and expanded panel (Live, Settings)
  shared/     IPC channel names and zod schemas used by all three processes
  core/       Pure TypeScript: note chunking, retrieval, Jev ranking, Luna guidance, pipeline
test/         Live Gateway smoke test (npm run test:gateway)
resources/    App and tray icons
```

## Flow

```
Simulate meeting line (renderer)
  → window.bee.runPipeline({ transcript })        preload → IPC
  → main: load notes, read API key                 key never leaves main
  → core/retrieve   BM25 keyword search, top 5 snippets
  → core/jev        Jev scores each snippet, re-orders (fails open)
  → core/luna       GPT-6 Luna writes up to 2 tips from the top 3 notes
  → PipelineResult back to the renderer
```

The renderer keeps the transcript and sends the last 8 lines with each run. The main process holds no meeting state.

## Processes and security

- The window is frameless, transparent, always on top and skipped from the taskbar. It sits at the top centre of the primary display's work area. It resizes between 440 × 64 px (collapsed) and 480 × 640 px (expanded).
- The renderer runs with `sandbox: true`, `contextIsolation: true` and no Node integration. A content security policy blocks remote scripts.
- Only the `media` permission (microphone) is granted.
- All IPC input is validated with zod in main. All IPC output is validated with zod in preload.
- Secrets are encrypted with `safeStorage` before they are written. If encryption is unavailable, they stay in memory for the session.

## AI calls

All model calls use the Vercel AI SDK (`ai`, `@ai-sdk/gateway`) against Vercel AI Gateway. Every call sends `providerOptions: { gateway: { serviceTier: "flex" } }`. No sampling parameters are sent (no temperature, topP, presencePenalty or frequencyPenalty).

| Step | Model | API | Timeout | Retries |
| --- | --- | --- | --- | --- |
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

Defined in `src/core/luna.ts`. The system prompt asks for at most two tips, one per line, under 20 words each. Tips must cite notes as `[n1]` and must not invent facts. If there is nothing useful, the model replies `NONE`. The user prompt holds the last 8 transcript lines and the notes labelled `[n1]`… The panel shows the same labels next to each note.

## Hard-coded values

| Value | Where | Setting |
| --- | --- | --- |
| Retrieval candidates | `core/pipeline.ts` | 5 |
| Notes sent to Luna | `core/pipeline.ts` | 3 |
| Jev minimum score | `core/jev.ts` | 1 (on a 0–3 scale) |
| Transcript lines per run | `renderer/src/store.ts`, `core/luna.ts` | 8 |
| Retrieval query window | `core/retrieve.ts` | last 3 lines, latest counted twice |
| BM25 k1 / b / title weight | `core/retrieve.ts` | 1.2 / 0.75 / 2 (standard defaults, not tuned) |
| Snippet length | `core/notes.ts` | 600 characters |

## Renderer state

One small external store (`renderer/src/store.ts`, read with `useSyncExternalStore`) holds settings, the transcript, the last result and the microphone state. Forms are uncontrolled and read with `FormData` on submit. There is no `useEffect`. The React Compiler is enabled.

## Not in v1

Live speech-to-text, system audio capture and the vmem connector.
