# Independent GUI test of Bee on Linux

This guide is for a tester who has the Linux build of Bee (the unpacked `linux-unpacked` folder or the AppImage) and no copy of the repository. It covers what must be in place, how to run Bee with a throwaway profile, the scenarios to run, how to read timings from the local log, and the limits of the Linux build.

Status of this guide: the steps below match the code in this branch. The packaged `linux-unpacked` build was built and started once in a headless container (`BEE_SMOKE_EXIT=1`, Xvfb, no D-Bus session), which proves it loads and keeps its profile in the folder given. No scenario below has yet been run on a Linux desktop with a working accessibility bus. Unit tests are not desktop proof. Record what you observe, including failures.

## 1. Platform prerequisite

Bee's computer use (click, type, read a page, send, delete) now runs on Linux, but only when the desktop session's **AT-SPI accessibility bus** answers over the **session D-Bus**. Bee reaches it through its bundled helper, agent-desktop.

| Session | Opening an app (`open_app`) | Opening a web page (`open_url`) | Click, type and read in an app |
|---|---|---|---|
| Desktop session with D-Bus and AT-SPI | Works (agent-desktop `launch`) | Works | Works, within the limits in section 8 |
| No session D-Bus (TTY, SSH without session variables, some containers) | Fails: Bee says it cannot reach the accessibility bus | Works (the system browser opens the page) | Does not run: Bee says it cannot reach the bus |

On Linux, opening an app also needs the bus, because Bee opens apps through agent-desktop. Only `open_url` works without it.

### Check the bus before you start

Run the bundled helper from the unpacked folder. Give it a fresh private state folder, so it never uses `~/.agent-desktop`:

```bash
cd linux-unpacked
AD_STATE=$(mktemp -d)
AGENT_DESKTOP_HOME="$AD_STATE" ./resources/agent-desktop/agent-desktop status
```

- Healthy: `"accessibility":{"state":"granted"}` and a non-empty `supported_surfaces` list.
- No bus: `"accessibility":{"state":"denied"}` with a suggestion such as "No D-Bus session bus is reachable". Run Bee from a terminal inside your graphical session instead.

Run it from the same terminal you will start Bee from: the bus address comes from that environment. Remove `$AD_STATE` afterwards if you wish; it holds only agent-desktop's snapshot state.

agent-desktop's own Linux guide lists Ubuntu 24.04 or later as measured, needs glibc 2.35 or later, and says other distributions need a recent at-spi2-core bridge. Debian has not been measured for this guide. If `status` is healthy but actions fail with AT-SPI errors, record the error and the at-spi2-core version.

### Chrome and other Chromium browsers

Chromium shows a page's controls on the bus only when its renderer accessibility is on. Quit every Chrome window first (a running Chrome ignores the flag), then start it with:

```bash
google-chrome --force-renderer-accessibility
```

Use `chromium --force-renderer-accessibility` for Chromium. Without the flag, Bee sees the browser window but almost nothing inside the page, and should say it cannot read that page. Electron apps need no flag.

## 2. Run Bee with an isolated profile

Never test with your everyday profile. Bee keeps settings, history, memory, notes and logs in its user data folder. On Linux, Electron's default is normally `~/.config/Bee` (Settings shows the exact logs path). Use a new, empty folder for every test run instead.

Bee honours either of these, and the command-line flag wins if both are given:

```bash
PROFILE=$(mktemp -d /tmp/bee-test-profile.XXXXXX)

# Either: the command-line flag
./bee --user-data-dir="$PROFILE"

# Or: the environment variable
BEE_USER_DATA_DIR="$PROFILE" ./bee
```

Both were checked in the packaged build: the single-instance lock and every file went into `$PROFILE`, and `~/.config/Bee` was not created.

Rules:

- Do not point the flag or variable at `~/.config/Bee` or any profile Bee uses day to day.
- Do not delete `SingletonLock`, `SingletonSocket` or `SingletonCookie` from a profile that a running Bee owns. If Bee reports that another copy is running, start with a new `mktemp -d` folder instead.
- A new profile is signed out and has no AI Gateway key. Sign in, then enter the key in Settings. Avoid typing the key on the command line, where shell history keeps it.
- Keep **Talk to Bee by saying 'Bee'** and **Ask before sending or deleting** on (both default to on).
- Keep **Verbose debug logs** on (the default) if you want timings (section 6).

### Electron's sandbox on the unpacked folder

If Bee exits at once with a message about the SUID sandbox helper, either make `linux-unpacked/chrome-sandbox` owned by root with mode 4755 (preferred), or, on a throwaway test machine only, add `--no-sandbox`. The AppImage needs FUSE (`libfuse2`); the unpacked folder does not.

## 3. Four ways to give Bee a request

Keep these apart in every report. A pass in one does not prove another.

| Path | What it exercises | What it does not prove | Where |
|---|---|---|---|
| A. Real microphone audio | Mic capture, phrase detection, speech-to-text, wake word routing, the request | Nothing is skipped | Turn the mic on and speak |
| B. E2E mic injection (`startTestMic`) | Wake word routing and the request, with text injected as a mic phrase | Audio, speech-to-text accuracy, false wakes from noise | Repository E2E tests only; not in this build's UI |
| C. Manual test: **Simulate meeting line** | The meeting tip pipeline. A typed meeting line never wakes Bee, even if it starts with "Bee" | The wake word path and any request | Live tab, Manual test |
| D. Manual test: **Talk to Bee (typed)** | The same wake word and request path a mic phrase takes after speech-to-text: "Bee, open Chrome" becomes a request; "Bee, stop" stops the request in flight | Audio, speech-to-text, false wakes | Live tab, Manual test |

Use D for the scenarios below unless a step says otherwise. Start every typed request with "Bee,". A line without it is dropped with a note; it never becomes a meeting line. Typed tests never prove speech-to-text; only A does.

## 4. Fixture page

Use `chrome-form.html`, shipped beside this guide (in the repository: `test/fixtures/chrome-form.html`). It is synthetic: no real person, account or payment, and its content security policy blocks all network requests. Each control changes only the page and shows what happened in the status line at the top, for example "Sent (fixture only, nothing left this page)". Compare Bee's reply with that status line.

Bee opens only `http` and `https` pages, so open the fixture yourself in Chrome started as in section 1:

```bash
google-chrome --force-renderer-accessibility /path/to/chrome-form.html
```

## 5. Scenarios

For each scenario, record: the request as typed, the island's reply word for word, what the screen or fixture status shows, and whether the reply matches the screen. "Expected" below is what the code and unit tests specify; it has not yet been observed on a Linux desktop.

1. **Open an app (quick path).** Type `Bee, open Chrome`.
   Expected: "Opened Chrome" with no AI call. If Chrome is already running and the session is X11, Bee brings it forward. On Wayland, Bee asks agent-desktop to launch it with activation instead.
2. **Cold app.** Quit Chrome. Type `Bee, open Chrome, then click Help in the fixture page` (with the fixture as the restored tab, or open it first).
   Expected: Bee waits while the browser starts (step line "Waiting for … to start…"), finds it under the name the system lists (for example `google-chrome`), and goes on. It should not loop on "app not found".
3. **Type without sending.** Type `Bee, type hi in the message box in Chrome`.
   Expected: the fixture message box holds "hi", the status line does not say Sent, and Bee does not claim it sent anything.
4. **Send with confirmation.** Type `Bee, send hi from the fixture message box`.
   Expected: a Confirm prompt before the Send click. On **Confirm**, the status line says Sent and Bee's reply may say sent. On **Cancel**, the reply is "Cancelled. Nothing was sent." and the status line does not say Sent.
5. **False completion check.** In any run where the status line does not say Sent, the reply must not say sent, delivered or posted. If the AI claims a send that no tool result in the run proved, Bee replaces the line, for example `Typed "hi"; Bee could not confirm it was sent.` Record both what the fixture shows and what Bee says.
6. **Delete, buy and submit.** Ask Bee to delete Fixture item A, to buy the fixture ticket, and to submit the sign-up form with a made-up name.
   Expected: a Confirm prompt before each. Cancel leaves the page unchanged and the reply says nothing was deleted, bought or submitted.
7. **Name ambiguity and correction.** In Settings, add two made-up names that sound alike when misheard, for example `Chris Lee` and `Krzysztof Nowak`, and save.
   - Type `Bee, send Chris a message saying hi`. Expected: "Which Chris: Chris Lee or Krzysztof Nowak?" with no action taken. The same for `Bee, open chris's chat`, `Bee, find krzys` and `Bee, call chris`.
   - Type `Bee, no, I meant Krzysztof Nowak`. Expected: Bee carries on with that name, and Settings still lists both names.
   - Quit Bee and start it again with the same `$PROFILE`. Expected: both names are still there, and `Bee, send Chris a message saying hi` asks again. Bee never stores a rule that one name means the other.
8. **Stop and cancel.** Start a longer task (scenario 2 or 4), then press **Stop** in the island or type `Bee, stop`. Expected: "Stopped." and no further action. Start one typed request, then another before it finishes. Expected: the first is cancelled and only the second runs.
9. **Calendar failure must not read as empty.** On a machine with no calendar app, type `Bee, open Calendar and tell me how many meetings I have today`. Expected: Bee says it could not open or read the calendar. It must not say "no meetings". The fixture's "Calendar (fixture)" section says it failed to load; ask `Bee, how many meetings does the fixture calendar show?`. Expected: Bee reports that the calendar failed to load, or that it cannot read it. Any "no meetings" answer is a fail. Note for the report: when a calendar tool was tried in that request, Bee's post-check replaces a "no meetings" line unless a calendar read succeeded; a web search or another app's read does not count. With no calendar tool tried, it replaces the line only when tools ran and no read succeeded.
10. **No accessibility bus.** Start Bee from a shell with no session D-Bus (for example an SSH session without the desktop's variables). Expected: Settings says Bee cannot reach the Linux accessibility bus; `Bee, click Help in Chrome` replies "Bee cannot reach the Linux accessibility bus (AT-SPI). Start Bee in your desktop session."; `Bee, open Chrome` replies that it cannot reach the accessibility bus. Bee must not crash.

## 6. Reading timings from the local log

Bee writes a JSON Lines log per session to `$PROFILE/logs/bee-<date>-<time>-<session>.jsonl`. Each line has `ts`, `category`, `event` and `data`. The log stays on the computer and Bee never deletes it.

The log holds your requests, screen text and replies. Do not share raw log files. Extract only timing fields, for example with `jq`:

```bash
LOG="$PROFILE/logs"

# Whole request as main saw it: total ms and the answer path's parts.
jq -c 'select(.event=="command-done") | {ts, ms: .data.ms, timings: .data.timingsMs}' "$LOG"/bee-*.jsonl

# Computer-use runs: total ms and steps, and whether the run stopped.
jq -c 'select(.category=="computer" and .event=="run-end") | {ts, ms: .data.ms, steps: .data.steps, stopped: .data.stopped}' "$LOG"/bee-*.jsonl

# Each model step inside a run: ms since the run started.
jq -c 'select(.category=="computer" and .event=="ai-step") | {ts, ms: .data.ms, steps: .data.steps}' "$LOG"/bee-*.jsonl

# One line per request from main: path (fast, computer, answer, which-name), total ms, the path choice (routeMs, and Jev's
# answer or "skipped"), the model's first reply (firstTokenMs), and each tool's ms.
jq -c 'select(.event=="command-timing") | {ts, path: .data.path, total: .data.totalMs, route: .data.routeMs, jev: .data.jev, first: .data.firstTokenMs, tools: .data.tools}' "$LOG"/bee-*.jsonl

# Speech-to-text per mic phrase, and the same figure on the request it started (sttMs; null for a typed request).
jq -c 'select(.category=="stt" and .event=="result") | {ts, ms: .data.ms}' "$LOG"/bee-*.jsonl
jq -c 'select(.event=="command-result") | {ts, ms: .data.ms, stt: .data.sttMs, classify: .data.classifyMs}' "$LOG"/bee-*.jsonl

# Events added for these checks: cold-app waits, rewritten claims, ambiguous names.
jq -c 'select(.event=="cold-app-wait" or .event=="claim-rewritten" or .event=="name-ambiguous") | {ts, category, event}' "$LOG"/bee-*.jsonl
```

To report a median, collect the `ms` values for one scenario over several runs and take the middle value, for example `jq -s 'map(.ms) | sort | .[length/2|floor]'` over the output of one of the commands above. State how many runs it covers. Do not report a median from fewer than five runs, and do not mix paths A and D in one figure.

A typed request writes a `wake` / `typed-command` line, and its `wake` / `command` line carries `"via":"typed-command"`. A mic request's `wake` / `command` line carries `"via":"mic"`. Use these to confirm which path a timing came from.

## 7. What to send back

For each scenario: pass or fail, the reply word for word, what the screen showed, the distribution and desktop (X11 or Wayland), and timing figures extracted as in section 6. Do not include raw logs, screenshots of personal content, or the Gateway key.

## 8. Compatibility limits

- **Builds.** Linux ships as an AppImage and as the unpacked `linux-unpacked` folder. Both carry agent-desktop for their architecture. Only the x64 unpacked build has been produced and started so far.
- **Accessibility bus.** Computer use and opening apps need AT-SPI on the session D-Bus. Without it, only opening web pages works.
- **Focus.** Bringing a window forward with `focus_window` needs X11. On Wayland, Bee relaunches the app with activation, and pointer-only gestures are refused by agent-desktop.
- **Browsers.** Chromium-based browsers need `--force-renderer-accessibility` for page content (section 1).
- **Identical controls.** On Linux an element can be used only when it was unique in its window. Two identical buttons cannot be told apart, and Bee should say so.
- **Teams.** There is no Teams audio helper on Linux, so Bee cannot hear the Teams app. Bee has no Linux playbook for Teams or Outlook. These tests do not cover Teams.
- **Speech.** Only path A tests the microphone and speech-to-text. False wake replies can only be tested with real audio.
