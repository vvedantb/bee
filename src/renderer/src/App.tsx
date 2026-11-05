import { ClerkFailed, Show, SignIn, UserButton, useAuth } from "@clerk/electron/react";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconNotebook,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { Badge, Button, Input, PillTabs, Textarea } from "@vvedantb/ui";
import { useEffect, useState, type FormEvent } from "react";
import { BeeLogo } from "./BeeLogo";
import { Favicon } from "./Favicon";
import { Connectors } from "./Connectors";
import { logSignIn } from "./debug-log";
import { MeetingContextSection } from "./MeetingContextSection";
import { MemorySection } from "./MemorySection";
import { NotchStatus } from "./NotchStatus";
import { MicHint } from "./MicHint";
import { SecretField } from "./SecretField";
import { SettingRow } from "./SettingRow";
import { computerAccessMessage } from "./computer-access";
import { INTERFACE_SCALES } from "../../core/interface-scale";
import { DEFAULT_MOTION_PREFERENCE, MOTION_PREFERENCES, resolveReducedMotion, type MotionPreference } from "../../core/motion-preference";
import { visibleChips, type LinkChip } from "../../core/link-suggest";
import { tipKey } from "../../core/steering";
import type { PipelineResult, SettingsView } from "../../shared/ipc";
import { displayTip, islandClick, mcpErrorNote, timingsLabel, timingsTitle } from "./island";
import { NOTCH_LOGO_PX } from "./logo";
import { focusKeyFieldWhenReady, GATEWAY_KEY_FIELD_ID, statusClick, type StatusClick } from "./island-click";
import { CONVERSATION_LABEL, NOTCH_BUTTON, NOTCH_UPDATE_BUTTON, logoState, notchLine, workingLabel, type NotchLine } from "./notch";
import { actions, answerFolded, displayResult, islandOpen, responseOpen, teamsAudioNow, useBee, type BeeState, type ComputerConfirm, type SummaryState, type TypedCommandOutcome, type UpdateState } from "./store";
import { TYPED_COMMAND_HINT, TYPED_COMMAND_PLACEHOLDER, TYPED_COMMAND_TITLE, typedCommandNote } from "./typed-command";
import { SyncCard, SyncSection, TeamSection, syncedWith } from "./Teams";
import { TEAMS_AUDIO_LISTENING } from "./teams-audio-message";
import { updateButton } from "./update";

const ICON = { size: 16, stroke: 1.75 };

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

// Suggestions only: a click asks main to open the link in the default browser. Nothing opens by itself.
function LinkChips({ chips }: { chips: LinkChip[] }) {
  if (chips.length === 0) return null;
  return (
    <ul className="link-chips" aria-label="Suggested links">
      {chips.map((chip) => (
        <li key={chip.id} className="link-chip">
          <Button type="button" variant="link" className="h-6 gap-1.5 rounded-full py-0 pr-1 pl-2.5 text-[13px] no-underline" title={chip.url} onClick={() => void actions.openLink(chip.url)}>
            <Favicon domain={chip.domain} />
            <span className="link-chip-label">{chip.label}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" className="size-6 rounded-full" title="Dismiss link" aria-label={`Dismiss ${chip.label}`} onClick={() => actions.dismissChip(chip.id)}>
            <IconX size={12} stroke={2} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

// Computer use waits for the user before it sends, deletes, buys or submits (Settings → Ask before sending or deleting). Only
// these two buttons answer it.
function ConfirmPrompt({ confirm }: { confirm: ComputerConfirm }) {
  return (
    <div className="island-confirm" role="group" aria-label={confirm.question}>
      <p>{confirm.question}</p>
      <p>{confirm.detail}</p>
      <div className="row actions">
        <Button type="button" size="sm" autoFocus onClick={() => void actions.answerConfirm(true)}>
          Confirm
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void actions.answerConfirm(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function IslandBody({
  result,
  chips,
  closing,
  keptTips,
  card,
  hint,
  hintClosing,
  confirm,
}: {
  result: PipelineResult | null;
  chips: LinkChip[];
  closing: boolean;
  keptTips: string[];
  card: string[];
  hint: BeeState["hint"];
  hintClosing: boolean;
  confirm: ComputerConfirm | null;
}) {
  const tips = result?.tips ?? [];
  const tipSources = result?.tipSources ?? [];
  const kept = new Set(keptTips.map(tipKey));
  return (
    <section className={closing ? "island-body closing" : "island-body"} aria-live="polite">
      <div className="island-inner">
        <Button type="button" variant="ghost" size="icon-sm" className="island-close" title="Dismiss" aria-label="Dismiss" onClick={() => void actions.dismissIsland()}>
          <IconX {...ICON} />
        </Button>
        {/* Answers open at the top and never scroll by themselves, so the user reads from the start. Scrolling keeps the body open. */}
        <div className="island-scroll scrollbar-thin" onScroll={() => actions.islandScrolled()}>
          <div className="island-content">
            {confirm ? <ConfirmPrompt confirm={confirm} /> : null}
            {card.length > 0 ? (
              <div className="island-card">
                {card.map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            ) : null}
            {tips.length > 0 ? (
              <ul className="island-tips">
                {/* Keyed by position: a streaming line grows in place instead of replaying the entrance. Kept tips are dimmed while Bee updates them. */}
                {tips.map((tip, index) => (
                  <li key={index} className={kept.has(tipKey(tip)) ? "kept" : undefined}>
                    {displayTip(tip)}
                    {tipSources[index] ? <span className="tip-source">{tipSources[index]}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <LinkChips chips={chips} />
            {result?.guideError ? <p className="island-error">{result.guideError}</p> : null}
            {result?.guideNote ? <p className="island-note">{result.guideNote}</p> : null}
            {hint ? <MicHint text={hint.text} closing={hintClosing} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

// Same flow as Settings → Updates, in one click: download if needed, then quit and install. Busy and failed show on the button.
function UpdateButton({ update }: { update: UpdateState }) {
  const { busy, failed, title } = updateButton(update);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={NOTCH_UPDATE_BUTTON}
      title={title}
      aria-label={title}
      aria-busy={busy}
      disabled={busy}
      onClick={() => void actions.updateNow()}
    >
      {busy ? <IconLoader2 {...ICON} className="spin" /> : failed ? <IconAlertTriangle {...ICON} className="error-text" /> : <IconDownload {...ICON} />}
    </Button>
  );
}

async function openKeyField(): Promise<void> {
  await actions.openTab("settings");
  await focusKeyFieldWhenReady({ find: () => document.getElementById(GATEWAY_KEY_FIELD_ID), nextFrame: (run) => requestAnimationFrame(run) });
}

function openStatus(click: StatusClick): void {
  if (click === "full-text") actions.openFullText();
  else if (click === "gateway-key") void openKeyField();
  else if (click === "panel") void actions.setExpanded(true);
  else if (click) void actions.openTab(click);
}

// The pill, and under it the response body: one dark surface that grows downward when an answer arrives.
function Island({ state }: { state: BeeState }) {
  const { isSignedIn } = useAuth();
  const open = state.expanded && !state.collapsing;
  const result = displayResult(state);
  const chips = visibleChips(state.chips, state.dismissedChipIds);
  // The body opens for a response, or for a mic hint alone. A hint alone leaves the pill as it was ("Listening…").
  const showResponse = responseOpen(state);
  const showBody = islandOpen(state);
  // While Luna thinks, chips may open the body but the pill keeps its thinking text.
  const cardOnly = (state.meetingCard?.lines.length ?? 0) > 0 && (result?.tips.length ?? 0) === 0;
  // In the conversation window after a request, the pill says Bee is listening for a follow-up (notch.ts CONVERSATION_LABEL).
  const answerText = state.conversationOpen ? CONVERSATION_LABEL : cardOnly ? "Last time" : "Tips";
  const line: NotchLine = showResponse && !state.busy && !state.heard && !state.mic.error ? { kind: "answer", text: answerText } : notchLine(state, isSignedIn);
  const status = line.text;
  // A folded answer opens in full in the island, even under a hint; status that asks for action opens its place in the panel (island-click.ts).
  const click = statusClick({ kind: line.kind, panelOpen: state.expanded, bodyShown: showResponse, answerFolded: answerFolded(state) });
  const newVersion = state.update.check?.available ? state.update.check.latestVersion : null;
  return (
    <div
      className={["island", state.busy && "thinking", showBody && "open"].filter(Boolean).join(" ")}
      onPointerEnter={() => actions.setIslandHover(true)}
      onPointerLeave={() => actions.setIslandHover(false)}
    >
      <header className="notch">
        <BeeLogo size={NOTCH_LOGO_PX} state={logoState(state)} level={state.mic.level} />
        {/* Keyed so each new status fades in. One component either way, so the panel opening or closing does not remount it. */}
        <NotchStatus key={status} status={status} click={click} error={Boolean(state.mic.error)} onOpen={openStatus} />
        {newVersion ? <UpdateButton update={state.update} /> : null}
        {/* Computer use in progress: one tap stops it, like saying "Bee, stop". */}
        {state.computer ? (
          <Button type="button" variant="secondary" size="sm" className="rounded-full" title="Stop" onClick={() => void actions.stopCommand()}>
            <IconPlayerStop {...ICON} /> Stop
          </Button>
        ) : null}
        {state.teams?.room ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="sync-chip rounded-full"
            title={`${syncedWith(state.teams)}${state.teams.shareMuted ? " · sharing paused" : ""}`}
            onClick={() => void actions.openTab("live")}
          >
            <IconUsersGroup {...ICON} />
            {state.teams.room.members.length}
          </Button>
        ) : null}
        <Show when="signed-in">
          <Button
            type="button"
            variant={state.mic.on ? "default" : "ghost"}
            size="sm"
            className={state.mic.on ? "rounded-full bg-[var(--accent)] text-[var(--surface)] hover:bg-[var(--accent)]" : NOTCH_BUTTON}
            title={state.mic.error ?? (state.mic.on ? "Stop microphone" : "Start microphone")}
            onClick={() => void actions.toggleMic()}
          >
            {state.mic.on ? <IconMicrophone {...ICON} /> : <IconMicrophoneOff {...ICON} />}
            <span className="mic-level" style={{ transform: `scaleY(${0.2 + state.mic.level * 0.8})` }} />
          </Button>
        </Show>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={open ? `chevron open ${NOTCH_BUTTON}` : `chevron ${NOTCH_BUTTON}`}
          title={open ? "Collapse" : "Expand"}
          onClick={() => void actions.setExpanded(islandClick("chevron", { panelOpen: open, bodyShown: showBody, hasResponse: false }) === "open-panel")}
        >
          <IconChevronDown {...ICON} />
        </Button>
      </header>
      {/* While busy the previous tips stay (and streamed tips replace them); displayResult drops the old error. A hint alone shows
          none of a closed response, and closing it closes the body. */}
      {showBody ? (
        <IslandBody
          result={showResponse ? result : null}
          chips={showResponse ? chips : []}
          closing={state.islandClosing || (state.hintClosing && !showResponse)}
          keptTips={state.revising ? state.keptTips : []}
          card={showResponse ? (state.meetingCard?.lines ?? []) : []}
          hint={state.hint}
          hintClosing={state.hintClosing}
          confirm={showResponse ? (state.computer?.confirm ?? null) : null}
        />
      ) : null}
    </div>
  );
}

function summaryLabel(summary: SummaryState, lineCount: number): string {
  if (summary.saving) return "Writing the summary…";
  const result = summary.result;
  if (result) {
    const name = result.path.split(/[\\/]/).pop() ?? result.path;
    return result.usedLlm ? `Saved ${name} to your notes.` : `Saved ${name} without AI. ${result.error ?? ""}`.trim();
  }
  if (lineCount === 0) return "Once the meeting starts, save decisions, action items and notes cited to your notes folder.";
  return "Saves decisions, action items and notes cited to your notes folder, so Bee can recall them next time.";
}

// The spoken lines are sent to main for the summary but never shown here. teamsAudio: Bee hears the Teams app now.
function MeetingSection({ summary, lineCount, teamsAudio }: { summary: SummaryState; lineCount: number; teamsAudio: boolean }) {
  return (
    <section>
      <h2>Meeting</h2>
      {teamsAudio ? (
        <p className="muted" role="status">
          {TEAMS_AUDIO_LISTENING}
        </p>
      ) : null}
      <div className="row actions">
        <Button type="button" size="sm" disabled={lineCount === 0 || summary.saving} onClick={() => void actions.endMeeting()}>
          <IconNotebook {...ICON} /> End meeting &amp; save summary
        </Button>
        {summary.result ? (
          <Button type="button" variant="link" size="sm" onClick={() => void actions.openSummary()}>
            <IconExternalLink {...ICON} /> Open summary
          </Button>
        ) : null}
      </div>
      <p className="muted">{summaryLabel(summary, lineCount)}</p>
      {summary.error ? <p className="error">{summary.error}</p> : null}
    </section>
  );
}

function LiveTab({ state }: { state: BeeState }) {
  const result = displayResult(state);
  // The notes list and its timings belong to the last finished run, not to streamed tips.
  const done = state.result;
  const chips = visibleChips(state.chips, state.dismissedChipIds);
  const mcpNote = mcpErrorNote(result?.mcpErrors);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const line = formString(form, "line") || actions.nextSampleLine();
    form.reset();
    void actions.simulateLine(line);
  }

  return (
    <div className="tab-body">
      <section>
        <h2>Tips</h2>
        {result && result.tips.length > 0 ? (
          <ul className="tips">
            {result.tips.map((tip, index) => (
              <li key={index}>{displayTip(tip)}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{state.busy ? workingLabel(state) : state.heard ? "Got it…" : state.mic.on ? "Listening…" : "No tips yet. Turn on the mic to start."}</p>
        )}
        <LinkChips chips={chips} />
        {state.mic.error ? <p className="error">{state.mic.error}</p> : null}
        {/* The island is hidden behind the panel, so the mic hint shows here too. Guidance, not an error. */}
        {state.hint ? <p className="muted">{state.hint.text}</p> : null}
        {result?.guideError ? <p className="error">{result.guideError}</p> : null}
        {mcpNote ? <p className="muted">{mcpNote}</p> : null}
        {state.error ? <p className="error">{state.error}</p> : null}
      </section>

      <SyncSection state={state} />

      <MeetingSection summary={state.summary} lineCount={state.session.lines.length} teamsAudio={state.teamsAudio.listening} />

      <section>
        <h2>
          Notes
          {done ? (
            <Badge className="ml-auto border-0 p-0 text-[11px] font-normal normal-case text-muted" title={timingsTitle(done.timingsMs)}>
              {done.rankSource === "jev" ? "ranked by Jev" : "retrieval order"} · {timingsLabel(done.timingsMs)}
            </Badge>
          ) : null}
        </h2>
        {done?.rankError ? <p className="error">{done.rankError}</p> : null}
        {done && done.notes.length > 0 ? (
          <ul className="notes">
            {done.notes.map((note) => (
              <li key={note.id}>
                <div className="note-head">
                  <strong>
                    {note.cite ? <span className="cite">[{note.cite}]</span> : null}
                    {note.title}
                  </strong>
                  <span className="muted">
                    {note.jevScore === null ? "–" : `Jev ${note.jevScore.toFixed(2)}/3`} · kw{" "}
                    {note.retrieveScore.toFixed(2)}
                  </span>
                </div>
                <p>{note.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{done ? "No matching notes." : "Matching notes appear here."}</p>
        )}
      </section>

      {/* Manual test: runs the same pipeline as a spoken phrase. The line is not kept on screen. */}
      <section>
        <h2>Manual test</h2>
        <TypedCommandForm busy={state.busy} />
        <form className="simulate" onSubmit={onSubmit}>
          <Input className="h-9" name="line" placeholder="A meeting line (never wakes Bee), or blank for a sample" autoComplete="off" />
          <Button type="submit" variant="secondary" size="sm" disabled={state.busy}>
            Simulate meeting line
          </Button>
        </form>
        {state.teams?.team ? (
          <SettingRow
            id="simulate-teams"
            label="Simulate Teams meeting (the sync popup shows after about 10 s)"
            checked={state.teams.detection.source === "simulated"}
            onCheckedChange={(on) => void actions.teams({ type: "simulateMeeting", on })}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Manual test → Talk to Bee (typed): a request through the wake word and request path, like a mic phrase after speech-to-text,
 * for testing without a microphone. Not a meeting line (that is the form below it), and not a test of audio or speech-to-text.
 */
function TypedCommandForm({ busy }: { busy: boolean }) {
  const [outcome, setOutcome] = useState<TypedCommandOutcome | null>(null);
  const note = typedCommandNote(outcome);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const line = formString(form, "command");
    const result = actions.typeCommand(line);
    setOutcome(result);
    if (result === "taken") form.reset();
  }

  return (
    <div className="flex flex-col gap-1">
      <form className="simulate typed-command" onSubmit={onSubmit} aria-label={TYPED_COMMAND_TITLE}>
        <Input className="h-9" name="command" placeholder={TYPED_COMMAND_PLACEHOLDER} autoComplete="off" aria-describedby="typed-command-hint" />
        <Button type="submit" size="sm" disabled={busy}>
          {TYPED_COMMAND_TITLE}
        </Button>
      </form>
      <p id="typed-command-hint" className="muted">
        {TYPED_COMMAND_HINT}
      </p>
      {note ? (
        <p className="error" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}

const STORAGE_LABEL: Record<SettingsView["secretStorage"], string> = {
  os: "Secrets are encrypted by the OS key store.",
  weak: "No OS keyring: secrets use weak fallback encryption.",
  memory: "No encryption: secrets stay in memory this session.",
};

const KEY_SOURCE_LABEL: Record<SettingsView["gatewayKeySource"], string> = {
  saved: "Saved key in use.",
  env: "Using BEE_AI_GATEWAY_API_KEY from env.",
  none: "No key set.",
};

function updateLabel(update: UpdateState): string {
  if (update.status === "checking") return "Checking for updates…";
  if (update.status === "downloading") return "Downloading update…";
  if (update.status === "ready") return "Update ready. Bee quits to install.";
  const check = update.check;
  if (!check) return "Not checked yet.";
  if (check.available) return `Bee ${check.latestVersion} is available.`;
  if (check.latestVersion) return "Bee is up to date.";
  return "No releases published yet.";
}

function UpdateSection({ update }: { update: UpdateState }) {
  const check = update.check;
  const busy = update.status === "checking" || update.status === "downloading";
  return (
    <section>
      <h2>Updates</h2>
      <p className="muted">
        Version {check?.currentVersion ?? "…"} · {updateLabel(update)}
      </p>
      {update.error ? <p className="error">{update.error}</p> : null}
      <div className="row actions">
        {update.status === "ready" ? (
          <Button type="button" size="sm" onClick={() => void actions.installUpdate()}>
            <IconPlayerPlay {...ICON} /> Quit &amp; install
          </Button>
        ) : check?.available ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void actions.downloadUpdate()}>
            <IconDownload {...ICON} /> Download update
          </Button>
        ) : null}
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void actions.checkForUpdate()}>
          <IconRefresh {...ICON} className={update.status === "checking" ? "spin" : undefined} /> Check for updates
        </Button>
        {check?.releaseUrl ? (
          <a className="text-accent hover:underline" href={check.releaseUrl} target="_blank" rel="noreferrer">
            Release notes
          </a>
        ) : null}
      </div>
    </section>
  );
}

// Settings → computer use: on a Mac, Accessibility for Bee. Computer use never needs Screen Recording.
function ComputerAccessSection({ access }: { access: BeeState["computerAccess"] }) {
  useEffect(() => {
    void actions.refreshComputerAccess();
  }, []);
  const message = computerAccessMessage(access);
  const mac = access?.supported === true && access.platform === "mac";
  if (!message && !mac) return null;
  const recheck = (open: () => Promise<void>) => async () => {
    await open();
    await actions.refreshComputerAccess();
  };
  return (
    <div className="flex flex-col gap-1">
      {message ? (
        <p className={access?.accessibility === "denied" ? "error" : "muted"} role="status">
          {message}
        </p>
      ) : null}
      {mac ? (
        <div className="row actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => void recheck(actions.openAccessibilitySettings)()}>
            Open Accessibility settings
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SettingsTab({ state, settings }: { state: BeeState; settings: SettingsView }) {
  const { update, error } = state;
  // Remounting the form after a save clears typed secrets and returns saved fields to their masked state.
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const gatewayApiKey = formString(form, "gatewayApiKey");
    const saved = await actions.saveSettings({
      gatewayApiKey: gatewayApiKey || undefined,
      fsRoots: formString(form, "fsRoots").split(/\r?\n/),
      knownNames: formString(form, "knownNames").split(/\r?\n/),
    });
    if (saved) setFormKey(formKey + 1);
  }

  return (
    <div className="tab-body">
      <form key={formKey} className="settings" onSubmit={(event) => void onSubmit(event)}>
        <SecretField
          name="gatewayApiKey"
          id={GATEWAY_KEY_FIELD_ID}
          label="AI Gateway API key"
          placeholder="vck_…"
          saved={settings.gatewayKeySource === "saved"}
          status={KEY_SOURCE_LABEL[settings.gatewayKeySource]}
          reveal={window.bee.revealGatewayKey}
          copy={window.bee.copyGatewayKey}
        />
        <label>
          Extra folders the AI may read (one absolute path per line)
          <Textarea name="fsRoots" rows={3} defaultValue={settings.fsRoots.join("\n")} spellCheck={false} />
        </label>
        <label>
          Names Bee should know (one per line). Bee also adds names you spell out or correct ("I meant …") and chat names it reads on screen. When a name could be two of these people, Bee asks which one.
          <Textarea name="knownNames" rows={3} defaultValue={settings.knownNames.join("\n")} spellCheck={false} />
        </label>
        <p className="muted">
          Notes folder: <code>{settings.notesDir}</code>{" "}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void window.bee.openNotesFolder()}>
            Open
          </Button>
        </p>
        <p className="muted">
          Debug logs: <code>{settings.logsDir}</code>{" "}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void window.bee.openLogsFolder()}>
            Open
          </Button>
        </p>
        {error ? <p className="error">{error}</p> : null}
        <div className="row">
          <Button type="submit" size="sm">
            Save
          </Button>
          {settings.gatewayKeySource === "saved" ? (
            <Button type="button" variant="link" size="sm" onClick={() => void actions.saveSettings({ gatewayApiKey: "" })}>
              Remove saved key
            </Button>
          ) : null}
        </div>
      </form>
      <SettingRow
        id="personalised-links"
        label="Personalised link suggestions"
        description="Sends the current line to Jev, and vmem if connected."
        checked={settings.personalisedLinks}
        onCheckedChange={(personalisedLinks) => void actions.saveSettings({ personalisedLinks })}
      />
      <SettingRow
        id="send-sessions-to-vmem"
        label="Send finished sessions to vmem"
        description="Send finished meetings and conversations to vmem so it can learn from them."
        checked={settings.sendSessionsToVmem}
        onCheckedChange={(sendSessionsToVmem) => void actions.saveSettings({ sendSessionsToVmem })}
      />
      <SettingRow
        id="meeting-mode"
        label="Meeting mode"
        description="Hidden from screen sharing, kept on top."
        checked={settings.meetingMode}
        onCheckedChange={(meetingMode) => void actions.saveSettings({ meetingMode })}
      />
      <SettingRow
        id="mic-hints"
        label="Mic hints"
        description="Suggest fixes when the mic is quiet, silent or too loud."
        checked={settings.hintsEnabled}
        onCheckedChange={(hintsEnabled) => void actions.saveSettings({ hintsEnabled })}
      />
      <SettingRow
        id="wake-word"
        label="Talk to Bee by saying 'Bee'"
        description="When your mic hears “Bee…” first, the rest is a request to the AI, not the meeting. It can open apps and links, and use apps for you. Say “Bee, stop” to stop."
        checked={settings.wakeWordEnabled}
        onCheckedChange={(wakeWordEnabled) => void actions.saveSettings({ wakeWordEnabled })}
      />
      <SettingRow
        id="ask-before-sending"
        label="Ask before sending or deleting"
        description="Before the AI sends a message or email, deletes something, buys something, or submits a form, Bee asks you to confirm in the island. Ordinary clicks, such as opening apps, tabs and menus, do not ask."
        checked={settings.askBeforeSendingEnabled}
        onCheckedChange={(askBeforeSendingEnabled) => void actions.saveSettings({ askBeforeSendingEnabled })}
      />
      <ComputerAccessSection access={state.computerAccess} />
      <SettingRow
        id="verbose-logging"
        label="Verbose debug logs"
        description="Keep a detailed log of each session on this computer, including what you ask the AI and its replies. Never uploaded. Off keeps warnings and errors only."
        checked={settings.verboseLogging}
        onCheckedChange={(verboseLogging) => void actions.saveSettings({ verboseLogging })}
      />

      <div className="flex flex-col gap-1">
        Interface size
        <PillTabs
          tabs={INTERFACE_SCALES.map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` }))}
          value={String(settings.interfaceScale)}
          onValueChange={(value) => {
            const interfaceScale = INTERFACE_SCALES.find((scale) => String(scale) === value);
            if (interfaceScale) void actions.saveSettings({ interfaceScale });
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        Animations
        <PillTabs
          tabs={MOTION_PREFERENCES.map((preference) => ({ value: preference, label: MOTION_LABEL[preference] }))}
          value={settings.motionPreference}
          onValueChange={(value) => {
            const motionPreference = MOTION_PREFERENCES.find((preference) => preference === value);
            if (motionPreference) void actions.saveSettings({ motionPreference });
          }}
        />
        <p className="muted">On ignores the OS reduced-motion setting.</p>
      </div>

      <MeetingContextSection
        settings={settings}
        onChange={(update) => void actions.saveSettings(update)}
        onClear={() => actions.clearMeetingMemory()}
        reader={state.meeting?.reader}
        onOpenAccessibility={() => void actions.openAccessibilitySettings()}
        teamsAudio={{ ...state.teamsAudio, plan: teamsAudioNow(state) }}
        onOpenScreenRecording={() => void actions.openScreenRecordingSettings()}
      />

      <MemorySection onLoad={() => actions.listMemory()} onClear={() => actions.clearMemory()} />

      <TeamSection state={state} />

      <UpdateSection update={update} />

      <p className="muted">{STORAGE_LABEL[settings.secretStorage]}</p>
    </div>
  );
}

function Panel({ state }: { state: BeeState }) {
  return (
    <main className="panel">
      <nav className="tabs">
        <PillTabs
          tabs={[
            { value: "live", label: "Live" },
            { value: "connectors", label: "Connectors" },
            { value: "settings", label: "Settings" },
          ]}
          value={state.tab}
          onValueChange={(tab) => actions.setTab(tab as BeeState["tab"])}
        />
        <span className="tabs-account">
          <UserButton />
        </span>
      </nav>
      {state.tab === "live" ? <LiveTab state={state} /> : null}
      {state.tab === "connectors" ? (
        <div className="tab-body">
          <Connectors servers={state.mcp.servers} tests={state.mcp.tests} error={state.mcp.error} />
        </div>
      ) : null}
      {state.tab === "settings" && state.settings ? <SettingsTab state={state} settings={state.settings} /> : null}
    </main>
  );
}

const MOTION_LABEL: Record<MotionPreference, string> = { system: "System", on: "On", off: "Off" };

/** Mirrors the Animations setting onto the root's data-motion; styles.css and the store's exit timers read it. */
function useMotionAttribute(preference: MotionPreference): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (systemReduce: boolean) => {
      root.dataset.motion = resolveReducedMotion(preference, systemReduce) ? "reduce" : "full";
    };
    if (preference !== "system") {
      apply(false);
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => apply(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);
}

/** Sign-in changes for the local debug log: signed in or out and a one-way user tag, never a token (debug-log.ts logSignIn). */
function useSignInLog(): void {
  const { isLoaded, isSignedIn, userId } = useAuth();
  useEffect(() => {
    if (isLoaded) void logSignIn(isSignedIn === true, userId);
  }, [isLoaded, isSignedIn, userId]);
}

export function App() {
  const state = useBee();
  useMotionAttribute(state.settings?.motionPreference ?? DEFAULT_MOTION_PREFERENCE);
  useSignInLog();
  return (
    // A press on the shell itself is on the window's clear area, outside the island: an answer open in full folds back.
    <div
      className={["shell", state.expanded && "expanded", state.collapsing && "collapsing"].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) actions.clickedOutside();
      }}
    >
      <Island state={state} />
      <Show when="signed-in">
        <SyncCard state={state} />
      </Show>
      {state.expanded ? (
        <>
          <Show when="signed-in">
            <Panel state={state} />
          </Show>
          <Show when="signed-out">
            <main className="panel sign-in">
              <BeeLogo size={56} className="sign-in-logo" title="Bee" />
              <SignIn routing="hash" withSignUp />
            </main>
          </Show>
          <ClerkFailed>
            <main className="panel sign-in">
              <p className="error">Sign-in could not load. Check your connection, then restart Bee.</p>
            </main>
          </ClerkFailed>
        </>
      ) : null}
    </div>
  );
}
