# Independent GUI test of Bee on Linux

This guide is for a tester who has the Linux build of Bee (the unpacked `linux-unpacked` folder or the AppImage) and no copy of the repository. It covers what must be in place, how to run Bee with a throwaway profile, the scenarios to run, how to read timings from the local log, and the limits of the Linux build.

Status of this guide: the steps below match the code in branch `cursor/grounded-desktop-port-4cff`, which ports the grounded desktop fixes onto the Claude Code session that runs "Bee, …" requests. No scenario below has been run on this build. Earlier builds (4c9e195, 9ccaf3d) failed scenarios B, C, D, G and H as listed in section 9; this build is meant to fix them, and only a desktop run can show that. Unit tests are not desktop proof. Record what you observe, including failures.

What this build changes, so you know what to watch:

- **Spelling wins for names.** With `Chris Lee` and `Krzysztof Nowak` known, "Krzys" means Krzysztof Nowak and "Chris" means Chris Lee. Bee asks only on a real tie ("Kris", or "Sara" with both Sara Kim and Sarah Ode known).
- **No relaunch.** Bee never starts an app when a visible window for it exists. If the accessibility bus does not list the app, Bee checks the X11 window list (`wmctrl -lx`) before it launches.
- **Writer keyboard.** When a document page (LibreOffice Writer) has no editable field, Bee types with the keyboard into the focused window.
- **Replace before send.** To send text X from a field that holds other text, Bee makes the field hold exactly X, reads it back, and only then shows the Confirm with that text. If it cannot, it says so and shows no Confirm.

Bee runs "Bee, …" requests through your own Claude Code install (signed in). Check that Settings shows Claude Code as ready before you start; otherwise only quick opens work.

## 1. Platform prerequisite

Bee's computer use (click, type, read a page, send, delete) now runs on Linux, but only when the desktop session's **AT-SPI accessibility bus** answers over the **session D-Bus**. Bee reaches it through its bundled helper, agent-desktop.

| Session | Opening an app (`open_app`) | Opening a web page (`open_url`) | Click, type and read in an app |
|---|---|---|---|
| Desktop session with D-Bus and AT-SPI | Works (agent-desktop `launch`) | Works | Works, within the limits in section 8 |
| No session D-Bus (TTY, SSH without session variables, some containers) | Fails: Bee says it cannot reach the accessibility bus | Works (the system browser opens the page) | Does not run: Bee says it cannot reach the bus |

On Linux, opening an app also needs the bus, because Bee opens apps through agent-desktop. Only `open_url` works without it. An app that is already open is found by the bus first, then by its visible X11 window (`wmctrl`, X11 only), so Bee never starts a second copy.

Install `wmctrl` (`/usr/bin/wmctrl`) on X11 desktops for the window-list fallback. Without it, Bee decides by the bus alone.

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

Expected: the single-instance lock and every file go into `$PROFILE`, and `~/.config/Bee` is not created. Check this on the first run.

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

Run A to H in this order, on a fixture page that was reloaded so the message box and the Sent list are empty. For each scenario, record: the request as typed, the island's reply word for word, what the screen or fixture status shows, and whether the reply matches the screen. "Expected" is what the code and unit tests specify for this build; none of it has been observed on a Linux desktop yet.

Setup for B, C, D and G: in Settings, add the two names `Chris Lee` and `Krzysztof Nowak` and save.

**A. Open an app, no relaunch.** Type `Bee, open Chrome` with the fixture Chrome window open.
Expected: "Opened Chrome" with no AI call. On X11 the fixture window comes forward. On Wayland, where a window cannot be brought forward, Bee replies "Chrome is already open; Bee could not bring it to the front". Pass only if the taskbar still shows one Chrome window and no first-run dialog appears. Also test with the Chrome window not listed by the accessibility bus if you can (for example Chrome started without the accessibility flag): Bee must still not start a second Chrome. Check the log for `desktop-action visible-window match` in that case.

**B. Spelling wins: "Krzys".** Type `Bee, type hi Krzys in the message box in Chrome`.
Expected: no question about which person. The box holds exactly `hi Krzys`, the Sent list stays empty, and Bee says it typed the text and has not sent it. Also type `Bee, message Chris`: Bee names Chris Lee only (and asks which app and what to say). Krzysztof Nowak must not appear as a "Chris".

**C. Send, replace, then Cancel.** With `hi Krzys` still in the box, type `Bee, send hi from the fixture message box`.
Expected: Bee replaces the box text with exactly `hi`, reads it back, and then shows the Confirm ("Send this?") with the text `hi` in the detail line. Click **Cancel**. Expected reply: "Cancelled. Nothing was sent." The box holds `hi` and the Sent list is empty. A reply that refuses because the box holds other text, or a Confirm that shows no text, is a fail.

**D. Send, replace, then Confirm.** Put `hi Krzys` back in the box (scenario B), then type the same request as C and click **Confirm**.
Expected: the status line says `Sent (fixture only, nothing left this page): "hi".` and the Sent list shows `hi`, never `hi Krzyshi`. Bee's reply says it sent `hi`. If Bee cannot make the box hold exactly `hi`, it must say so and show no Confirm; record that as a fail of the replace step, not a pass.

**E. Delete with confirmation.** Type `Bee, delete Fixture item A`. Expected: a Confirm ("Delete this?") before the click. Cancel: "Cancelled. Nothing was deleted." and item A stays.

**F. Calendar failure must not read as empty.** Type `Bee, how many meetings does the fixture calendar show?`. Expected: Bee says the calendar failed to load or that it cannot read it. Any "no meetings" answer, or a count, is a fail.

**G. Name tie and a real ambiguity.** Type `Bee, message Chris`. Expected: Chris Lee only, then a question for the app and the words. Then add `Sara Kim` and `Sarah Ode` as names and type `Bee, send Sara a message on Teams saying hi`. Expected, within about a second and with no action taken: "Which Sara: Sara Kim or Sarah Ode?". The same for `Bee, send Kris a message on Teams saying hi`: "Which Kris: Chris Lee or Krzysztof Nowak?". Then type `Bee, no, I meant Krzysztof Nowak`: Bee carries on with that name, and Settings still lists every name. Restart Bee with the same `$PROFILE`: the names are still there, and the same request asks again. Bee never stores a rule that one name means another.

**H. Writer keyboard.** Quit LibreOffice. Type `Bee, open LibreOffice Writer and type hello`.
Expected: Bee waits for LibreOffice (it lists as `soffice` and can take ten seconds or more on a first start), types `hello` into the Writer window with the keyboard, and says what it checked. The page shows `hello`. Bee must not say it cannot control Writer, and must not start a second Writer if one is open. If a Document Recovery dialog opens first, record it: Bee should say it has not typed `hello` yet, not that it did. Dismiss it yourself and ask again; never choose Recover on a test profile you care about.

**I. Other checks (as before).**

1. **Stop and cancel.** Start a longer task (D), then press **Stop** in the island or type `Bee, stop`. Expected: "Stopped." and no further action. Start one typed request, then another before it finishes: the first is cancelled and only the second runs.
2. **No accessibility bus.** Start Bee from a shell with no session D-Bus (for example an SSH session without the desktop's variables). Expected: Settings says Bee cannot reach the Linux accessibility bus; `Bee, click Help in Chrome` replies "Bee cannot reach the Linux accessibility bus (AT-SPI). Start Bee in your desktop session."; `Bee, open Chrome` replies that it cannot reach the accessibility bus. Bee must not crash.
3. **False completion check.** In any run where the status line does not say Sent, the reply must not say sent, delivered or posted. In any run where the box does not hold the text, the reply must not say Bee typed it. If the AI claims an action that no tool result proved, Bee replaces the line (log event `claim-rewritten`). Record both what the fixture shows and what Bee says.
4. **Cold app.** Quit Chrome. Type `Bee, open Chrome`. Expected: Bee waits while the browser starts and finds it under the name the system lists (for example `google-chrome`). It must not loop on "app not found". No reply may name an internal tool (`open_app`, `list_apps`).

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

# Events for these checks: rewritten claims, ambiguous names, names settled from recent requests, a send blocked because the
# field would not hold the exact text, a field that differed after typing, and keyboard typing into a document.
jq -c 'select(.event=="claim-rewritten" or .event=="name-ambiguous" or .event=="name-recent" or .event=="send-blocked" or .event=="field-differs" or .event=="keyboard-type") | {ts, category, event}' "$LOG"/bee-*.jsonl
```

To report a median, collect the `ms` values for one scenario over several runs and take the middle value, for example `jq -s 'map(.ms) | sort | .[length/2|floor]'` over the output of one of the commands above. State how many runs it covers. Do not report a median from fewer than five runs, and do not mix paths A and D in one figure.

A typed request writes a `wake` / `typed-command` line, and its `wake` / `command` line carries `"via":"typed-command"`. A mic request's `wake` / `command` line carries `"via":"mic"`. Use these to confirm which path a timing came from.

## 7. What to send back

For each scenario: pass or fail, the reply word for word, what the screen showed, the distribution and desktop (X11 or Wayland), and timing figures extracted as in section 6. Do not include raw logs, screenshots of personal content, or the Gateway key.

## 8. Compatibility limits

- **Builds.** Linux ships as an AppImage and as the unpacked `linux-unpacked` folder. Both carry agent-desktop for their architecture. Which architecture and format you tested is part of your report.
- **Accessibility bus.** Computer use and opening apps need AT-SPI on the session D-Bus. Without it, only opening web pages works.
- **Focus.** Bringing a window forward with `focus_window` needs X11. On Wayland, Bee says a running app is already open rather than launch a second copy, and pointer-only gestures are refused by agent-desktop. Bee still reads and acts on an open app there.
- **Browsers.** Chromium-based browsers need `--force-renderer-accessibility` for page content (section 1).
- **Identical controls.** On Linux an element can be used only when it was unique in its window. Two identical buttons cannot be told apart, and Bee should say so.
- **Teams.** There is no Teams audio helper on Linux, so Bee cannot hear the Teams app. Bee has no Linux playbook for Teams or Outlook. These tests do not cover Teams.
- **Keyboard typing.** The keyboard fallback types letters, digits, spaces, commas, full stops, slashes and hyphens, at most 200 characters, into the focused window. It does not type line breaks or other marks; ask for Return with a key press.
- **Reading a field back.** The replace-before-send check needs agent-desktop to read the field's value. For a field it cannot read, Bee cannot check and goes on as before; record which apps behave that way.
- **Window list.** The no-relaunch fallback needs X11 and `wmctrl`. On Wayland, Bee relies on the bus listing and on "already open" when it cannot bring a window forward.
- **Speech.** Only path A tests the microphone and speech-to-text. False wake replies can only be tested with real audio.

## 9. Earlier results, for comparison

These are results from earlier builds, kept so a tester can see what this build must fix. They are not results for this build.

| Scenario | Build 4c9e195 | Build 9ccaf3d |
|---|---|---|
| A. Open Chrome | Pass | Pass |
| B. Type `hi Krzys` | Fail: asked "Which Krzys: Chris Lee or Krzysztof Nowak?" | Pass |
| C. Send `hi`, Cancel | Pass (the box was empty) | Fail: Bee refused to send because the box held `hi Krzys`; no Confirm |
| D. Send `hi`, Confirm | Pass (the box was empty) | Fail: `hi Krzys` became `hi Krzyshi`; no Confirm |
| E. Delete, Cancel | Pass | Pass |
| F. Calendar failure | Pass | Pass |
| G. Name tie | Pass, but offered Krzysztof Nowak as a "Chris" | Pass |
| H. Writer `hello` | Fail: "cannot control" | Fail: a Document Recovery dialog blocked Writer; nothing typed |

Source: the two e2e result files from those builds (RESULTS for 4c9e195 and 9ccaf3d), as supplied by the tester.
