# Bee

## Install (Windows)

**Installer (recommended):** download `Bee.Setup.x.y.z.exe` from [Releases](https://github.com/vvedantb/bee/releases) and run it. The app is not code-signed yet, so Windows SmartScreen may warn — choose More info → Run anyway.

**Portable:** download `Bee-x.y.z-win.zip`, unzip, run `Bee.exe`.

**From source:**
```powershell
npm install
npm run build:teams-audio:win   # call audio helper; needs Visual Studio 2022 (C++ workload) and CMake
npm run dist:win
# outputs under release/
```

## Install (macOS)

Download `Bee-x.y.z-arm64.dmg` (Apple Silicon) or `Bee-x.y.z.dmg` (Intel), or the matching `-mac.zip` from [Releases](https://github.com/vvedantb/bee/releases). Open the dmg and drag Bee to Applications. Builds are not signed or notarised yet, so Gatekeeper will warn: right-click Bee, choose **Open**, then confirm.

- **Microphone.** macOS asks the first time Bee starts. If you decline, allow Bee under System Settings → Privacy & Security → Microphone.
- **Screen Recording.** For two things only. Call audio: macOS counts any app's sound as screen recording; Bee hears the call app alone (Teams, Zoom, or the browser running Google Meet) and never records the screen or other apps, and never asks during a call (see [Call audio](#call-audio)). And a picture of a window when a "Bee, …" request needs one (see [Talk to Bee](#talk-to-bee)): to answer about the front window, or to see an app it is using for you and click in it. The first time, macOS shows its own prompt. **Live** (for call audio) and **Settings** (for pictures of windows) show **Open Screen Recording settings** when Bee does not have it. Without it, Bee uses your mic only and reads windows as text.
- **Menu bar.** Bee has no Dock icon. The tray icon is a menu bar extra: click it for Show / hide, Open notes folder, Open logs folder and Quit.
- **Shortcuts.** Two global shortcuts, each with `Cmd` on a Mac and `Ctrl` on Windows and Linux. `Cmd+Shift+Space` shows or hides Bee and never opens the typing box. `Cmd+Option+Space` (`Ctrl+Alt+Space` on Windows and Linux) shows Bee with focus and opens the typing box: type a request ("open Figma", "summarise this") and press Enter, the same as saying it after "Bee". Esc closes the box. Change either in **Settings → Show or hide Bee** and **Settings → Type to Bee**: click Change and press the new keys. Bee saves a shortcut only if it can hold it, and Settings says when another app holds the current one. The two shortcuts cannot be the same.
- **Notes folder.** `~/Library/Application Support/Bee/notes`.
- **Debug logs.** `~/Library/Application Support/Bee/logs` (see [Debug logs](#debug-logs)).
- **Teams detector.** Windows only. On macOS open a Teams, Zoom or Google Meet call: Bee reads its window.
- **Meeting window.** Always on, with no setting. Bee reads the Teams, Zoom or Google Meet window (its name, the people listed and live captions) through the accessibility tree, read-only. On macOS it needs Accessibility: turn on Bee under System Settings → Privacy & Security → Accessibility. Settings shows whether access is granted.

**From source:**
```bash
npm install
npm run build:teams-audio:mac   # call audio helper for arm64 and x64; needs Xcode with the macOS 13 SDK or later
npm run dist:mac
# outputs under release/ (dmg and zip, one each for arm64 and x64)
```

Signing is off by default. To sign and notarise, set `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder, and set `build.mac.notarize` to `true` (it is `false` now), with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the environment.

Bee is a desktop overlay for meetings. It sits as a small "notch" at the top centre of the screen. It listens to the meeting, finds relevant local notes, ranks them with Jev and shows one or two short tips from the AI (Claude Haiku 5.5). When a question is about a public or current fact that the notes do not cover, the AI can search the web, and the Live tab lists the source links under the tips. This uses the same Gateway key. The search is Anthropic's own web search tool, so the Gateway sends those calls only to the Anthropic provider.

Windows and macOS are supported. The Teams detector is Windows only.

Typical use: in a weekly meeting someone says "last time we discussed the Acme renewal". Bee hears it, finds your Acme notes, ranks them with Jev and shows a tip. If someone asks a direct question ("when does SSO ship?", "what's 15% of 18,000?"), the tip answers it from your notes or general knowledge.

## Requirements

- Windows 10 or 11 (x64), or macOS (Apple Silicon arm64 or Intel x64). Linux runs in development.
- Node.js 22 or later, with npm.
- A Vercel AI Gateway API key with access to `mistral/voxtral-small-transcribe-3`, `anthropic/claude-haiku-5.5` and `typesafe-ai/jev`.
- For "Bee, …" requests and computer use: [Claude Code](https://claude.com/claude-code) 2.1.318 or later, installed and signed in to your Claude account (run `claude`, then `/login`). Bee uses that install and its login through the Claude Agent SDK, not the Gateway, and ships no copy of its own. Settings shows whether Bee found it; without it, Bee says to install, update or sign in.
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
2. Open **Settings** and paste your AI Gateway key, then click **Save**. To talk to Bee by name ("Bee, …"), install Claude Code and sign in; Settings says when Bee has found it.
3. Click the **microphone** on the notch and talk. The bar in the mic button shows the input level. Each phrase you say runs the pipeline. Bee does not show what was said; only tips and notes appear. Click the microphone again to stop.
4. To ask without speaking, press the **Type to Bee** shortcut and type a request in the box that opens in the notch. There is no typed meeting line: meeting lines come from the mic, live captions or call audio.
5. Bee retrieves matching notes, ranks them with Jev, and shows up to two tips. The panel shows the tips, not the notes or their ranking. While the AI works, the notch shows what it is doing (for example "Searching the web"). When the answer arrives, a card opens under the notch with the tips and any source links. Click **×** to dismiss it. If you leave the pointer off it, it folds back to one line in the notch after at least 30 seconds (longer for longer answers), and the same tips stay on **Live**. Click that line to read the answer in full in the island again; click outside to fold it. The chevron opens the full panel. A new question after an answer has finished shows only the new answer; speaking while Bee is still answering updates the answer on screen.
6. Meetings start and end by themselves (**Live → Meeting → Automatic meeting detection**, on by default). When a Teams, Zoom or Google Meet call begins, Bee turns the mic on and the notch says "Meeting in progress, Bee is active" for a few seconds. While it runs, the notch says "Meeting in progress". When the call ends, Bee writes `meeting-YYYY-MM-DD-HHmm.md` to the notes folder, with decisions, action items (with owners), topics and the notes cited, and the notch says "Meeting ended, notes have been saved" for a few seconds. Click **Open summary** on **Live** to view it. When a Teams call is about to start, Bee shows itself without taking focus: on Teams' join screen (**Meeting join**) it says so in the notch and records nothing. With the setting on, Bee starts recording only once the call itself is on; with the setting off, the notch says "Meeting detected" and shows a **Start meeting** button, which becomes **Stop meeting** once the meeting starts. There is no other button to start or end a meeting. With the setting off, Bee starts no meetings and saves no summaries by itself; the microphone still works for Talk to Bee. A meeting that runs for 4 hours is stopped and saved. Next time, Bee finds the file like any other note. Without a key, or if the AI call fails, Bee saves a plain summary with the meeting lines instead.

Notes are markdown files in the notes folder (the **Memory** tab shows the path and has an **Open** button). On Windows this is `%APPDATA%\Bee\notes`; on macOS it is `~/Library/Application Support/Bee/notes`. Four fictional seed notes are written the first time the folder is empty. Edits are picked up on the next line; no restart is needed.

The AI can also list, search and read these notes with file tools, for questions the top three notes do not cover. For "Bee, …" requests, Claude Code's own tools can read any other folder; meeting tips read only the notes folder. The AI can add to a note (create or append, `.md` only, notes folder only) when you clearly ask it to. It never overwrites a file. Limits: paths must stay inside the notes folder (`..`, either slash style, and symbolic links are refused); binary files and files over 256 KiB are skipped; lists stop at 200 entries, searches at 20 hits, and a read returns at most 64 KiB.

**Meeting mode** hides Bee from screen sharing and keeps it above full-screen apps.

### What the AI sees during a meeting

While a meeting is active (the notch says "Meeting in progress"), each tip request also gets what is on your screen. This is always on in a meeting and never runs for the mic alone. There is no setting.

- **Text first.** Bee reads the text of the window at the front (its accessibility text, through agent-desktop), up to 1,500 characters, page text before button labels. It never reads Bee, terminals, password managers or system settings, and never reads password fields.
- **A picture only when needed.** When the window has under 80 characters of text (an image, a canvas), or it is the call window itself (a shared slide there is video), Bee adds a small picture of that window: JPEG, at most 1024 px on its long side. At most one picture every 20 seconds, and only when the window looks different from the last picture sent. On macOS this needs Screen Recording; without it Bee sends text only and never asks during a call. On Linux, text only.
- **Tips stay fast.** The screen is read while notes are ranked. A tip waits at most 0.4 s for the text and 0.8 s in all, then goes on without it. A text read is reused for 5 seconds.
- **Privacy.** The text and picture go to the AI (Claude Haiku through AI Gateway) with that one tip request only. Bee never saves the picture, and keeps the screen out of meeting memory, summaries and vmem transcripts. Logs show only lengths, whether a picture was sent, whether it changed, and times. The AI is told to treat the screen as data, to use it only when it helps, and never to repeat passwords or keys.
- **Cost.** Text adds up to about 400 input tokens to a tip request. A picture adds image tokens (Anthropic counts about width × height / 750, so roughly 800 for a 1024 × 576 window) to at most one tip request every 20 seconds.

### Link suggestions and personalised links

When a spoken line or a tip names a website (a URL, `convex.dev`, "convex dot dev", or a short list of names such as GitHub or Vercel), Bee shows a chip under the tips, with the site's icon. The chip shows at once, even while the AI is still working. A click opens the link in your default browser. **×** hides the chip for this turn. Bee never opens a link by itself.

**Personalised link suggestions** pick the exact page you mean. For "vercel logs for vibot", the chip can read `vercel.com › vibot › logs` and open that page, taken from your browsing history or bookmarks in [vmem](https://github.com/vedantb2/vmem), when vmem is connected.

1. Open the **Connectors** tab (the panel has four tabs: **Live**, **Connectors**, **Memory** and **Settings**). Bee ships no preset connectors: the tab lists only the servers you add. Click **Add custom**, enter a name and your vmem MCP URL, and save, then click **Connect** on its row. There is no API key: a remote server with authentication "None" signs in with MCP OAuth. Connect opens your system browser to sign in; the browser returns to a one-time server on `127.0.0.1` (random port) and Bee stores the tokens encrypted in the main process. Disconnect removes the server and its tokens. Bee treats a server as vmem only when it reports its name as `vmem` (any case) in the MCP handshake (`serverInfo.name`), not by its display name or URL. Each row shows the icon the server provides (`serverInfo.icons`, the dark-theme icon first), else its website's favicon, else the first letter of its name. To choose your own, fill **Icon URL** (https or `data:image`) in the connector's form. Servers saved before presets were removed keep working as ordinary rows, with their sign-in.
2. Keep the **Gateway key** set in **Settings**: Jev, which makes the choice, runs through AI Gateway.
3. That is all: personalised links are on while an enabled vmem connector exists, and off otherwise. There is no switch.

Without a vmem connector, Jev still scores the plain domain chip, and can remove it when no link helps.

How it works: the cheap detector runs first, and nothing else runs when it finds no site. Bee opens one connection to vmem at app start (when signed in) and after each Connectors change, and reuses it. For each chip, main searches it through Bee's MCP client (`memory_search`, or the closest search tool), once for browsing history and once for bookmarks, for pages on that domain, keeps up to five, and asks Jev (`typesafe-ai/jev`) two things on a 0 to 3 scale: should a link show at all, and which page fits best. A chip shows only when both scores are at least 2 (`LINK_MIN_SCORE` in `src/core/link-rank.ts`). A low "should show" score removes the chip. A missing or invalid answer keeps the plain domain chip.

It fails open. The whole step has a 2 second limit. With no vmem connector or the Gateway key missing, you keep the plain domain chip. If vmem is not connected, is offline or is slow, Jev still runs on the plain domain (the MCP connection is kept warm, and each search call has a 1 s limit). On any error or timeout you keep the plain domain chip, and Bee logs a debug line (`Bee: personalised links fell back: …`). Each turn is looked up once.

**Privacy:** with an enabled vmem connector, the current line (and the tip text for chips from tips) goes to Jev through AI Gateway, and to your vmem connector when one is enabled. Without one, nothing is sent and plain chips still work. Keys and connector tokens stay in the main process and are encrypted like the Gateway key.

**Icons** are fetched by the main process, since the window's content policy blocks remote images. Bee tries `/favicon.ico`, then the icon named in the site's home page, then Google's favicon service (`google.com/s2/favicons`, which sees the domain name). Icons are kept as small data URLs in memory and in the `favicons` folder of the user data folder for 7 days. Until an icon loads, or if none does, the chip shows a globe. Loopback addresses (127.0.0.0/8, 0.0.0.0, ::1) and dotless names are never fetched or opened.

### Before and after meetings

- **Briefing.** Two minutes before a meeting with other people on it, the island shows who is on it, when you last met and what was left open (from saved meetings). **Dig deeper** starts a background task that searches your connected tools, read only. Bee reads today's calendar from classic Outlook on Windows; otherwise it asks your Claude Code once an hour, through your own calendar tools (MCP). With no calendar tool, it stops asking until the next day. Always on.
- **Follow-up.** When a meeting's summary is saved (by hand, or by itself when the call ends), the island lists its action items with **Draft follow-up email** and **Create tasks**. Each is a background task on your Claude Code, which uses the email and task tools you have connected. Emails are saved as drafts, never sent.
- **What did I miss?** Back after 15 minutes with no keyboard or mouse input (or a locked screen, or sleep), the island shows a short **Recap**: what others said in the meeting meanwhile (teammates, captions, call audio), background tasks that ended, briefings shown and summaries saved, with the follow-up buttons or **Open summary**. Three or more missed lines are summed up by the AI in up to 3 bullets; without a Gateway key, Bee lists the latest lines. Nothing happened: no card (when you ask, Bee says so). Turn the mic on in a meeting others have started and Bee offers the same recap once ("Before you joined"). Ask any time: "Bee, what did I miss?" (or "catch me up") recaps since you last used Bee, but not before the meeting began.

### Talk to Bee

With the mic on, start a phrase with **"Bee"** (or "Hey Bee") and the rest is a request to the AI, not part of the meeting: "Bee, what's 15% of 18000?", "Bee, open Teams", "Hey Bee, open bbc.co.uk". The answer shows in the island straight away, written to you, not as words to say in the meeting. If you pause after "Bee", your next phrase is the request.

- **Your own mic only.** Typed lines, live captions, call audio and teammates' lines never count, even when they start with "Bee". Speech-to-text often writes "Bee" as "B", "Be" or "Bea"; at the very start of a phrase those count too, when a pause or a request follows ("Be, open Teams", "B what's the time in Tokyo"). "Be careful…", "maybe later" and "the bee flew" do not. "Bea, can you share your screen?" to a colleague called Bea does count.
- **Not meeting conversation.** The request and its answer stay out of the meeting summary, and meeting memory. Meeting tips wait while the answer is on screen (8 s, or until you close it), then catch up.
- **Desktop actions.** The AI can open an app or bring it to the front ("open Teams", "switch to Outlook"), bring one window forward, and open a web page. "Open" or "switch to" a common app, and "open" a web address, run at once without the AI. Each action shows a short line, such as "Opened Teams". Bee never opens terminals or script tools. Opening apps works on Windows and macOS.
- **Background tasks.** A long job that needs no screen ("Bee, draft the release notes from the merged PRs and tell me when it's done") runs in the background while you carry on. A chip in the notch shows how many run; the Live tab lists each with what it is doing and a Stop button. When one ends, the island shows its result, and Bee remembers it ("what did it find?"). Up to 3 at once; they never use the screen.
- **What you are looking at.** Every "Bee, …" request carries the app and title of the window at the front, so "summarise this" or "reply to him" needs no "can you see". Bee reads the window itself only when the request needs what it shows.
- **Claims Bee can back.** A reply that says Bee sent, deleted, bought, submitted or typed something, or that your calendar is empty, is checked against what its tools actually did. If nothing proves it, Bee shows a cautious line instead ("Bee could not confirm anything was sent."). Commands and file edits by Claude Code's own tools cannot be checked, so those claims stay as written.
- **Remembering on its own.** Bee saves lasting facts it learns (who owns what, your preferences) without being asked, and says so under the reply ("Remembered: …"). Review or clear them on the **Memory** tab.
- **Reading your screen.** Ask "Bee, can you see what I'm working on?", "what's on my screen?" or "summarise this page": Bee reads the window at the front (or the app you name) through its accessibility tree and answers from it. It only reads, never clicks or types, never reads Bee itself or the apps computer use avoids, and takes no picture for that. When the text is not enough ("what does this chart show?", "does this design look right?", or an app that exposes no text), the AI may call **look_at_screen**: one picture of the front window (or, when that window cannot be captured alone, the display it is on, with Bee hidden). The pill shows "Looking at your screen…". Bee never takes one of Bee itself, password managers, terminals, system settings or the other apps computer use avoids. On macOS it needs Screen Recording; Windows needs no permission; Linux has no pictures.
- **Using apps for you.** For a task on screen, such as "Bee, open Discord, send Sam a message, then close the Discord tab in Chrome", the AI uses your apps step by step: it reads a window, clicks, types, presses keys, scrolls and closes tabs or apps, and checks each step. The pill shows the step ("Clicking Send…") and a **Stop** button; "Bee, stop" also stops it. It ends with one line, such as "Sent the message and closed the tab." It stops by itself after 3 minutes, or when it repeats the same step with the same result three times. It never reads, pictures or types into terminals (including one inside another app), script tools, system settings, password managers or Bee itself. It works through the controls an app exposes to accessibility tools first. When a control refuses, or an app shows none it can use (Teams' compose box, an app that draws its own controls), the AI may **look**: take a picture of that one app window, then click, drag or scroll at a point in it with the real mouse. Each point needs a fresh picture of a window that has not moved, at most 12 pictures a task. Before a click at a point, Bee reads what sits there: a Send, Delete, Buy or Submit asks you first, and so does any spot Bee cannot read ("Click here?"). It can also right-click, double-click and paste text (the clipboard gets its old text back after). When the picture does not help either, Bee says it cannot control that app. Windows and macOS (Linux on X11 for pictures and points).
- **Teams messages.** "Bee, message Sam on Teams saying I'm running late" (also "tell Sam in Teams that …", "send Sam a Teams message: …", "reply to Sam in Teams with …", "draft a message to Sam on Teams saying …") runs Bee's own steps, not the AI: it opens Teams, presses Ctrl+E (Cmd+E on a Mac), types the name, picks the first result, and checks that the chat with that person opened (the window title or a heading names them). Only then does it paste the message into the message box and read it back. It asks you to **Confirm** with the name and the exact text, presses Enter, and checks the box emptied: "Sent to Sam Lee." Cancel leaves the draft in the box ("Drafted, not sent."). A draft request stops before sending. If Bee cannot check the right chat opened, it types nothing and hands the task to the AI with what it did. It never touches a draft of your own already in the box. Windows and macOS.
- **Ask before sending or deleting** (always on). Before the AI sends a message or email, deletes something, buys something, or submits a form, the island asks you to **Confirm** or **Cancel**. It also asks before a click or drag at a point where Bee cannot read what is there. Only a tap answers it, never speech.
- **Your real browser (OpenCode Browse).** With [OpenCode Browse](https://github.com/anomalyco/browse) installed (Settings → **Install**, then add its extension), tasks on websites run in background tabs of your own browser, with your logins; desktop apps still use computer use. When a step needs you (a login, 2FA, a payment), Browse hands you the tab. Before a browser step that sends, posts, buys, submits or deletes, the island asks you to **Confirm**, as above; background tasks cannot, so they never do those steps.
- **Mac permissions.** Using apps needs Accessibility for Bee (System Settings → Privacy & Security → Accessibility). A picture (look_at_screen, or look while using an app) needs Screen Recording (System Settings → Privacy & Security → Screen Recording); without it, the AI says so and works from the accessibility tree. Settings shows when either is missing, with a button for its pane. Windows needs no permission.
- **What the AI sees.** While it uses an app, the AI gets the text of the windows Bee reads, and a picture of one app window only when it calls look. A picture (a JPEG, at most 1568 px on its long side) goes only to your Claude Code in that request. Bee never saves it to disk, never puts it in its history, and logs only its size. Claude Code keeps it in its own session file on this computer (`~/.claude/projects`), as it does every request. Bee does not log the text either.
- Talking to Bee by name is always on.

### Speech-to-text

Bee transcribes with **Voxtral Small** (`mistral/voxtral-small-transcribe-3`) through Vercel AI Gateway, using the same Gateway key as the AI and Jev. Each call lists the words to listen for: "Bee", Jev, vmem and the names of people Bee has learned (from your corrections, chat names on screen and meeting speakers). This fixes most misheard names.

1. The mic is captured with Web Audio. A simple level detector cuts the audio into phrases: speech, then 0.8 s of silence, up to 15 s per phrase (an early result comes at 0.4 s; see below). Blips under 0.3 s are dropped without a Gateway call. Bee never mixes system audio into the mic. [Call audio](#call-audio) is a separate stream of the call app alone.
2. Each phrase is sent to the main process as a 16 kHz mono WAV. Main calls Voxtral (Gateway default tier) and returns the text.
3. The text joins a short internal buffer (the last 8 lines), and the pipeline runs. The words are never shown on screen.

**Early result.** Bee does not wait for the full 0.8 s of silence. At 0.4 s of silence it sends the phrase so far, so the text is usually ready about 0.9 s after you stop talking (it was about 1.4 s). If you start talking again before 0.8 s (a thinking pause), the phrase goes on: the early request is cancelled, and at the real end the whole phrase is sent once. Its text then replaces the early line:

- Same words (only punctuation, case or filler differ): the line is updated quietly, and nothing runs again.
- Changed words: the answer on screen is updated, as for a line spoken over it. It is never cleared as a new topic.
- A phrase that could be a request to Bee ("Bee, open …", or any phrase while Bee is listening for one) waits for its final text, so "Bee, open … Teams" stays one request.

Each phrase costs one request, or two when you resume after a pause. A second pause in the same phrase sends nothing more. The meeting summary waits up to 3 s for final text.

If a phrase fails to transcribe, the notch shows a short error (for example "Speech-to-text failed: AI Gateway authentication failed…"). The mic stays on and the error clears after the next phrase succeeds. Without a key, the notch says to add one in Settings.

Bee no longer uses the Web Speech API. Electron could not reach Google's speech service, so it failed with a network error.

To check it by hand: sign in, click the mic, say "when does SSO ship for enterprise customers?". The Q4 roadmap notes and a tip should appear. `npm run test:e2e` runs the same path in Electron with a fake microphone (see [Tests](#tests)).

### Updates

Bee checks the [latest GitHub release](https://github.com/vvedantb/bee/releases/latest) at start-up. When a newer version has an installer for your platform, a download icon shows on the notch. **Settings → Updates** shows your version, **Check for updates**, then **Download update** and **Quit & install**. On Windows, Bee downloads the NSIS installer to the temp folder, opens it and quits; the installer replaces Bee and starts it again. On macOS it opens the `.dmg`. Offline, or with no release published, Settings shows a short message and Bee carries on. The installer is unsigned, so SmartScreen may warn.

The tray icon (the menu bar extra on macOS) has Show/hide, Open notes folder, Open logs folder and Quit. The avatar in the panel's tab bar manages your account and signs you out.

### Debug logs

Bee keeps a detailed log of each session on your computer, so a session can be read back and debugged. The logs are in the `logs` folder beside the notes folder: `%APPDATA%\Bee\logs` on Windows, `~/Library/Application Support/Bee/logs` on macOS. Settings shows the path and has an **Open** button.

- **Files.** JSON Lines, one event per line, one file per session (`bee-YYYY-MM-DD-HHmmss-<session>.jsonl`). A new file starts each day and when a file reaches 64 MB.
- **Kept forever.** Bee never deletes, trims or overwrites a log file. Remove old files yourself if you need the space.
- **Local only.** Logs are never uploaded. Keys, tokens and sign-in details are redacted before anything is written.
- **Detailed debug logs** (always on) log everything: what Bee hears, what you ask the AI and its replies, and each step it takes on screen.

## Teams

Teams sync was removed from the Bee app. Bee no longer joins teams or sync rooms, and has no **Teams** tab, **Settings → Team**, invite codes or `bee://team` links. The relay (`relay/`, `convex/`) stays in the repository and may still run on the server, but the app does not use it. Bee still never joins a call and uses no Teams bot, no Teams local API and no Microsoft Graph.

Bee still detects Teams, Zoom and Google Meet calls to start and end meetings (see **Use**, step 6), reads live captions and can hear the Teams app (below).

Relay environment variables (server side only):

| Variable | Where | Meaning |
| --- | --- | --- |
| `CLERK_ISSUER` | Relay | Clerk issuer, default `https://clerk.vedantb.com`. |
| `CLERK_JWKS_URL` | Relay (optional) | JWKS for RS256 checks. Default `<issuer>/.well-known/jwks.json`. |
| `CLERK_AUTHORIZED_PARTIES` | Relay (optional) | Comma-separated `azp` allowlist. |

### Call audio

Call audio is always on; there is no switch. With your mic on in a call, Bee hears the call app itself, so other people's words reach the AI and the summary as theirs, not yours. It listens when all of these hold:

- your Bee mic is on, and Bee sees a call in Teams, Zoom or Google Meet (from the call window, or on Windows the built-in Teams detector).

Bee hears the app of the call it sees. If you move to a call in another app, Bee stops and starts again on the new app.

What it hears joins your transcript as "Meeting: …" (someone other than you; the app does not say who). A phrase that repeats a caption from the last 20 seconds is dropped, as the caption names the speaker.

**Echo.** Without headphones, your mic also hears the call through your speakers. A mic phrase that repeats what call audio heard in the last 10 seconds is dropped, so it never counts as yours (and a "Bee, …" from someone else never wakes your Bee). When the mic's copy arrives first, the call-audio phrase replaces it. Phrases match when they share most words (0.6 word overlap).

Bee does not say that it is listening. While a meeting is active, the notch and **Live → Meeting** say "Meeting in progress"; the status line says "Listening to call audio.".

**The call app only, never all system audio.** A small helper program that ships inside Bee captures one app alone (source in `native/teams-audio`). If it cannot keep to that app, it does not start.

| | Windows | macOS |
| --- | --- | --- |
| Needs | Windows 10 version 2004 (build 19041) or later. Microsoft documents the API from build 20348 (Windows 11 and Windows Server 2022). If an older Windows 10 build refuses, Live says so. | macOS 13 or later |
| Permission | None | Screen Recording ("Screen & System Audio Recording" on macOS 15) |
| Teams | The Teams app (`ms-teams.exe` or `Teams.exe`) and the programs it runs, such as its web view | The Teams app and its helper apps |
| Zoom | The Zoom app (`Zoom.exe`) and its helper programs | The Zoom app (`us.zoom.xos`) and its helper apps |
| Google Meet | The browser that shows the Meet window (Chrome, Edge, Brave, Arc, Firefox, Vivaldi or Opera) and its processes | The same browsers and their helper apps. Not Safari: Safari's sound comes from shared system processes, so Bee cannot keep to it |
| Never | Other apps, the rest of the system, music or video players. If the app has started a program that is not part of it, Bee stops listening rather than hear it. | Other apps, the screen |

**A browser is heard whole.** For Google Meet, Bee hears the whole browser that runs the call: **every tab** of that browser, not only the Meet tab. A video or music in another tab of the same browser is heard too. Use a different browser for other media during a call, or turn the switch off.

**macOS permission.** macOS files any app's sound under Screen Recording. Bee never asks during a call. When it needs access, **Live → Meeting** says so and shows **Open Screen Recording settings**. That button asks macOS once (its own prompt), then opens System Settings → Privacy & Security → Screen Recording. Turn on Bee. If Bee still cannot hear the call, quit and reopen Bee. Unsigned builds may need this again after an update, because macOS ties the permission to the app's signature. On macOS 15, macOS may also ask from time to time whether Bee may keep access.

**Fails open.** A missing helper, an old OS, no permission, the call app not running or any helper error: **Live → Meeting** says why, Bee carries on with your mic, and it tries again in the next call (or when the call moves to another app).

**Privacy.** Call audio stays in memory in Bee's main process. Each phrase goes to speech-to-text like a mic phrase, and only the text reaches the window. Console logs carry codes and counts (and which kind of app: teams, zoom or meet), never audio, words, process names or window titles. With verbose debug logs on, the text is also kept in the local [debug log](#debug-logs); audio never is.

Before this release, Bee mixed all system audio into the mic. That is gone. See [ARCHITECTURE.md](ARCHITECTURE.md#call-audio) and [native/teams-audio/README.md](native/teams-audio/README.md).

### Risks and limits

- **Detection false positives and misses.** The Windows heuristic can fire on a Teams call that is not a meeting, or on another app's title that mentions a call inside Teams. It can miss new Teams builds with different window titles. On Windows, Bee reads window titles with both `tasklist` and PowerShell, because `tasklist` often shows no title for new Teams. Automatic detection also reads the microphone privacy record of Windows to see which meeting app holds the mic.
- **Consent.** The summary contains colleagues' words, stored on your device. Tell participants, and get a privacy or legal review before wide use. Call audio sends other people's words to speech-to-text.
- **Unsigned installer.** Windows SmartScreen warns on first run.

## Sign-in (Clerk)

Bee uses [`@clerk/electron`](https://www.npmjs.com/package/@clerk/electron) with the **vedantb.com** Clerk production instance.

| Setting | Value |
| --- | --- |
| Publishable key | `pk_live_Y2xlcmsudmVkYW50Yi5jb20k` (override with `VITE_CLERK_PUBLISHABLE_KEY` at build time) |
| Frontend API host | `clerk.vedantb.com` |
| Renderer origin | `bee://renderer` (Bee loads `bee://renderer/`, not `file://`) |
| OAuth redirect | `http://127.0.0.1:45789/sso-callback` (Bee's sign-in page on this computer) |
| Return to Bee link | `bee://renderer/` |

One-off setup in the [Clerk Dashboard](https://dashboard.clerk.com) for the vedantb.com instance:

1. **Native applications → enable Native API.** Without it, Clerk rejects Bee with "Production Keys are only allowed for domain vedantb.com" and the panel shows "Sign-in could not load".
2. **Allowlist the redirect URLs** (Native applications → Allowlist for mobile SSO redirect):
   - Add exactly `http://127.0.0.1:45789/sso-callback`. Do this before you release a build with the loopback redirect, or social sign-in will fail. The trailing-slash form (`…/sso-callback/`) is not needed: Bee always sends the URL without it.
   - Keep `bee://renderer` and `bee://renderer/*`. Bee still uses them as its app origin and for the **Return to Bee** link.
3. Turn on the sign-in methods you want (email, Google and so on) under **User & authentication**.

Clerk session tokens are stored by the main process, encrypted with `safeStorage`. Without an OS keyring they are not saved, so you sign in again after each restart.

Social sign-in (Google, for example) opens the system browser. When it ends, the browser comes back to a small server that Bee runs on `127.0.0.1:45789` only while a sign-in is waiting (`src/main/clerk-oauth-loopback.ts`). The tab then shows Bee's own page: **Signed in to Bee**, **Almost done** (finish in Bee), **Sign-in was cancelled** or **Sign-in did not finish**, each with a **Return to Bee** button. Bee comes to the front as soon as the browser reaches that page. A sign-in waits up to 3 minutes, and only one runs at a time. If another app is using port 45789, social sign-in fails and Bee logs `Bee could not start sign-in: port 45789 is in use.`; email sign-in still works.

The browser does not return through `bee://renderer/`: a browser cannot show a `bee://` link as a page, so the tab would stay on the provider's sign-in page.

The installer registers the `bee` scheme for **Return to Bee**. Social sign-in no longer depends on the scheme to finish. In `npm run dev` on Windows, the scheme points at the bare Electron binary, so **Return to Bee** may not open the app there.

## Settings and secrets

| Field | Storage | Used in v1 |
| --- | --- | --- |
| AI Gateway API key | Encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) | Yes |
| Connector tokens (Connectors tab) | Encrypted the same way | Yes |
| Meeting mode | Plain JSON | Yes |

Settings live in `settings.json` in the Electron user data folder. Secrets never reach the renderer: the UI only sees whether a key is set. A saved key shows as `•••••••• (saved)` with a **Replace** button; the real key is never put in the page.

If no key is saved, Bee uses `BEE_AI_GATEWAY_API_KEY` from the environment. A saved key takes precedence. Bee keeps no Claude credentials: "Bee, …" requests use Claude Code's own login. Bee looks for `claude` in `BEE_CLAUDE_PATH`, then `PATH`, then the usual install folders (`~/.local/bin`, Homebrew, `%USERPROFILE%\.local\bin`…).

`npm run test:claude` runs live "Bee, …" requests on this machine's Claude Code (installed and signed in); `test/command.e2e.test.ts` runs one through Electron's main process.

On Linux without a keyring (for example, under Xvfb), Electron cannot encrypt to disk. Bee then keeps secrets in memory for the session only, and Settings says so.

## Tests

```powershell
npm test               # unit tests: retrieval, Jev ranking parser, AI prompt, meeting summary, pipeline, sign-in gate, phrase detection, WAV, STT, update checks, Teams mode (relay, JWT, room ranking, detection, sync)
npm run test:gateway   # live smoke test against Vercel AI Gateway (needs BEE_AI_GATEWAY_API_KEY)
npm run test:e2e       # Electron E2E: fake mic → Grok STT → Jev → AI, meeting summary files, screenshots (needs BEE_AI_GATEWAY_API_KEY; xvfb-run on Linux)
npm run relay:mock     # in-memory relay on http://127.0.0.1:8787 (the app no longer uses it; relay tests only)
npm run typecheck
npm run build:teams-audio:win   # call audio helper (Windows only; needs Visual Studio 2022 C++ and CMake)
npm run build:teams-audio:mac   # call audio helpers (macOS only; needs Xcode)
```

`test:gateway` makes eight calls:

1. `mistral/voxtral-small-transcribe-3`: transcribes `test/fixtures/sso-question.wav` (a synthesised question with silence either side).
2. `mistral/voxtral-small-transcribe-3` with an invalid key: checks for a short `Speech-to-text failed:` error.
3. `anthropic/claude-haiku-5.5`: one short guidance completion.
4. `anthropic/claude-haiku-5.5`: a current-events question ("who is the current Prime Minister of the UK?"), checked for a tip and at least one `https://` source.
5. `anthropic/claude-haiku-5.5`: a question about a local note (a room number in a temp notes folder), checked that the tip holds the answer, so the AI used the file tools.
6. `anthropic/claude-haiku-5.5`: a meeting summary from a short transcript, checked for every section and the named owner.
7. `typesafe-ai/jev`: scores three note snippets against a fake transcript and checks that the relevant note ranks first.
8. `typesafe-ai/jev` with an invalid key: checks that ranking fails open, keeps the original order, and returns a clear error.

`test:e2e` builds the app, then starts Electron with Chromium's fake audio device playing the same WAV. A small harness (`test/e2e/`) loads Bee's real preload and main IPC handlers, and a page that runs Bee's real mic capture and phrase detector. It checks that Grok STT returns the question, the roadmap note ranks first and the AI gives a tip. It skips Clerk and sends an unsigned token with Bee's issuer, which is all the main-process gate checks.

The summary E2E uses the same harness without a mic. It runs a short fake meeting, ends it, checks the markdown file in a temp notes folder (every section, the notes cited, the named owner), and checks that the next pipeline run retrieves the summary. It runs once with the AI and once without a key (plain summary).

Both fail straight away with a clear message if `BEE_AI_GATEWAY_API_KEY` is not set.

The live MCP E2E (`test/mcp-live.e2e.test.ts`) is skipped, including under `test:e2e`, unless both `BEE_E2E_MCP_FILE` and `BEE_AI_GATEWAY_API_KEY` are set. `BEE_E2E_MCP_FILE` points to a JSON file (keep it mode 0600) shaped `{ "servers": [{ "id", "name", "url", "bearer"? , "oauth"? }] }`, where `oauth` is the stored MCP OAuth state; the harness re-reads it on every run and writes refreshed tokens back. Run it with `npx electron-vite build && npx vitest run --config vitest.e2e.config.ts test/mcp-live.e2e.test.ts` (on Linux without a display, `test/e2e/run.ts` uses `xvfb-run`). It asks three questions without the mic and checks that the AI names vmem and Eva as Bee's connectors, calls an Eva tool for a table count, and calls a vmem tool for a memory search. The harness prints each MCP call as an `E2E_MCP_CALL` line (tool, server, ok, size, a short preview; never tokens).

The live conversation E2E (`test/conversation-live.e2e.test.ts`) is skipped unless `BEE_AI_GATEWAY_API_KEY` is set. It renders Bee's real store and island in one Electron window, turns the mic on without capture (`startTestMic` in `store.ts`) and hands lines in where speech-to-text would, so no STT call is made. Five turns: a news question, a "why" follow-up with the mic still on (answered with a reason within 15 s), an unrelated question (a fresh turn, nothing kept), a question steered to Paris while it runs (earlier tips kept), and mic off (no late run for 10 s). It prints a per-turn table, `E2E_MARK` lines with timestamps and the number of pipeline runs (at most 6). With `BEE_E2E_SHOTS_DIR` it opens the full text after turns 2 and 4, checks it stays scrolled to the top and writes `conversation-turn2-fulltext.png` and `conversation-turn4-fulltext.png`. Run it with `npx electron-vite build && npx vitest run --config vitest.e2e.config.ts test/conversation-live.e2e.test.ts`.

The live mic latency E2E (`test/mic-latency.e2e.test.ts`) costs money, so it is skipped, including under `test:e2e`, unless `BEE_E2E_LIVE_MIC=1` and `BEE_AI_GATEWAY_API_KEY` are set. The fake audio device plays `test/fixtures/london-tube-question.wav` (a London news question, then "why are there tube closures" with the mic still on) into the store's real mic, segmenter and Grok STT (`startTestMicCapture` in `store.ts`). For each line it reports the end-of-speech detection delay against the known speech end, end of speech → transcript and transcript → first answer text. It checks that both lines are transcribed apart and answered, with no `[web]` tag, at most 4 STT calls and 3 pipeline runs, and no Jev call (the notes folder holds one unrelated note). With `BEE_MIC_REPORT=<file>.md` it writes the report there and the raw timings beside it as `.json`.



Unit tests cover the relay (JWT signature, issuer, expiry and `azp` checks; team invite and join; room ids, word codes and membership; phrase stamping; stale members and the 4-hour limit; two-tap merge). They also cover room ranking, the detection debounce, the Windows heuristics against sample `tasklist` and registry output, and the share gate. The last group covers the sync controller with two or three devices on one relay, including concurrent meetings, the "Which meeting?" pick, equally ranked syncs, leaving when the chosen meeting closes, merging, leaving without rejoining, and fail-open.

### Teams control check (developer only)

`scripts/teams-control-check.mjs` finds which step of controlling Microsoft Teams fails on one machine. Run it from a repo checkout on Windows or macOS, with Teams signed in:

```powershell
npm install
npm run check:teams                     # or: node scripts/teams-control-check.mjs
npm run check:teams -- --json           # only the summary JSON
```

It drives Teams through the bundled `agent-desktop` CLI (set `AGENT_DESKTOP_PATH` to use another binary). It prints one `PASS`, `FAIL` or `SKIP` line per step: version, status and permissions; Teams running (it starts Teams if not, unless `--skip-launch`); window; focus; accessibility snapshot; click on a chat list item (headless, then headed); `Ctrl+E` (`Cmd+E` on macOS) into search; the compose box (set-value, headed type and paste of the text `bee-check`, then clear); screenshot; mouse move; and, on Windows, whether the console had the foreground at start. It ends with a summary table and one JSON line to paste back to the developer. Exit code 0 means every critical step passed.

- **It never sends a message.** It never presses Return or Enter and never clicks a control named Send. A guard refuses those commands, and the guard tests itself before the first command. It writes only `bee-check`, only into an empty compose box, and clears it. It puts your clipboard back after the paste test.
- **Default output has no names.** It shows counts, roles, error codes and process names, not message text, chat names or window titles. `--verbose` adds them.
- Other flags: `--keep` (keep the screenshot PNG), `--timeout-ms N` (per command, default 30000), `--app NAME` (Teams process name, if detection misses it).
- **It is not part of the release.** `build.files` packs only `out/**`, `resources/**` and `package.json`, so `scripts/` never ships.

## Manual steps and known limits

- **Gateway key.** Create one in the Vercel dashboard (AI Gateway → API keys).
- **Clerk.** Enable Native API and allowlist `bee://renderer` / `bee://renderer/*`. See [Sign-in (Clerk)](#sign-in-clerk).
- **Electron binary.** `npm install` does not download Electron itself. It downloads on first `npm run dev` or `npm start`. On a restricted network, allow `github.com` downloads or set `ELECTRON_MIRROR`.
- **Call audio.** Not yet tested on a real call in any app. CI builds both helpers and checks they are packaged and answer `--version` and `--protocol`; it cannot join a call. Before release, check on a packaged build on Windows 11, Windows 10 22H2 and macOS 13 or later, in Teams, Zoom, and Google Meet in Chrome, Edge and Firefox: the other side is heard; music from another app is not; your own voice is not labelled as someone else; with speakers instead of headphones, the far end is not labelled as you; moving from one app to another restarts capture; and on macOS the Screen Recording steps work.
- **Speech-to-text on Windows.** Not yet tested on a real Windows machine with a microphone. The full path was checked in Electron on Linux with a fake microphone and live Grok STT. The speech threshold (about −40 dBFS) is fixed and not tuned; a very quiet mic may never start a phrase.
- **Talk to Bee desktop actions.** Not yet tested on a real Windows or macOS desktop. Unit tests fake every OS call. Before release, check on packaged builds: "Bee, open Teams" opens or brings forward Teams (Windows `msteams:`, macOS `open -a "Microsoft Teams"`); "Bee, switch to Outlook" with Outlook running; "Bee, open Slack" from the Windows Start menu; "Bee, open bbc.co.uk". agent-desktop `focus-window` may need macOS Accessibility; without it Bee falls back to `open -a`.
- **Computer use.** Not yet tested on a real desktop: unit tests mock the AI and agent-desktop, with no live AI calls. Before release, check on packaged builds: the Discord example above (a Confirm appears before the message goes); Stop and "Bee, stop" mid-task; a Mac without Accessibility (one line, no loop).
- **OpenCode Browse.** Not yet tested with a real browser and extension: unit tests use a fake `browse` binary and Bee's own gate. Before release, check Settings → Install on each OS, and that "Bee, email Sam in Gmail" asks to Confirm before it sends.
- **Microphone.** Windows asks for microphone permission the first time you click **Mic**. If it is blocked, allow desktop apps under Settings → Privacy & security → Microphone.
- **Code signing.** Not configured. Add a certificate to `build.win` in `package.json` before distributing.
- **Transparency on Linux.** Without a compositor (for example, Xvfb), the area around the notch may show as black rather than transparent.
- **Not tested here.** Encrypted key storage across restarts was not exercised on real Windows in this build. The Linux in-memory path and the unpacked Windows package were checked.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together, including the Jev prompt format.

## Licence

MIT. See [LICENSE](LICENSE). Instrument Sans is bundled under the SIL Open Font License 1.1 (`src/renderer/src/fonts/OFL.txt`). The experimental meeting window reader ships [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0); its license is at `resources/licenses/agent-desktop-Apache-2.0.txt` and, in packaged builds, beside the binary under `Resources/agent-desktop/LICENSE`.
