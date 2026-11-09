import { ClerkFailed, Show, SignIn, UserButton, useAuth } from "@clerk/electron/react";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { Badge, Button, Input, PillTabs } from "@vvedantb/ui";
import { useEffect, useState, type FormEvent } from "react";
import { AskBox } from "./AskBox";
import { IslandCard } from "./IslandCard";
import { BackgroundChip, BackgroundSection } from "./Background";
import { BeeLogo } from "./BeeLogo";
import { Favicon } from "./Favicon";
import { Connectors } from "./Connectors";
import { logSignIn } from "./debug-log";
import { MeetingContextSection } from "./MeetingContextSection";
import { ClaudeCodeSection } from "./ClaudeCodeSection";
import { BrowseSection } from "./BrowseSection";
import { MeetingButton } from "./MeetingButton";
import { MemorySection } from "./MemorySection";
import { NotchStatus } from "./NotchStatus";
import { PANEL_TABS } from "./panel-tabs";
import { watchNaturalWidth } from "./pill-measure";
import { MicHint } from "./MicHint";
import { SecretField } from "./SecretField";
import { SettingRow } from "./SettingRow";
import { KnownNamesField, PreferenceRows } from "./SettingsFields";
import { DEFAULT_ASK_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT } from "../../core/shortcut";
import { ShortcutRow } from "./ShortcutRow";
import { computerAccessMessage, screenRecordingMessage } from "./computer-access";
import { INTERFACE_SCALES } from "../../core/interface-scale";
import { DEFAULT_MOTION_PREFERENCE, MOTION_PREFERENCES, resolveReducedMotion, type MotionPreference } from "../../core/motion-preference";
import { visibleChips, type LinkChip } from "../../core/link-suggest";
import { tipKey } from "../../core/steering";
import type { PipelineResult, SettingsView } from "../../shared/ipc";
import { displayTip, islandClick, mcpErrorNote, timingsLabel, timingsTitle } from "./island";
import { NOTCH_LOGO_PX } from "./logo";
import { focusKeyFieldWhenReady, GATEWAY_KEY_FIELD_ID, statusClick, type StatusClick } from "./island-click";
import { CONVERSATION_LABEL, NOTCH_BUTTON, NOTCH_UPDATE_BUTTON, logoState, notchLine, workingLabel, type NotchLine } from "./notch";
import { actions, answerFolded, displayResult, islandOpen, responseOpen, teamsAudioNow, useBee, type BeeState, type ComputerConfirm, type TypedCommandOutcome, type MeetingCard, type SummaryState, type UpdateState } from "./store";
import { TYPED_COMMAND_HINT, TYPED_COMMAND_PLACEHOLDER, TYPED_COMMAND_TITLE, clearsTypedCommand, typedCommandNote } from "./typed-command";
import { MEETING_IN_PROGRESS } from "./meeting-notices";
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

// Computer use always waits for the user before it sends, deletes, buys or submits. Only these two buttons answer it.
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
  asking,
}: {
  asking: boolean;
  result: PipelineResult | null;
  chips: LinkChip[];
  closing: boolean;
  keptTips: string[];
  card: MeetingCard | null;
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
            {asking ? <AskBox onSubmit={(text) => actions.submitAsk(text)} onClose={() => actions.closeAsk()} /> : null}
            {confirm ? <ConfirmPrompt confirm={confirm} /> : null}
            {card && card.lines.length > 0 ? <IslandCard card={card} onPress={(button) => void actions.pressCard(button)} /> : null}
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

// The pill's header reports its natural width to the store, which sizes the compact pill and the window (applyWindowSize).
const watchPill = (header: HTMLElement) => watchNaturalWidth(header, (natural) => actions.measurePill(natural));

// The pill, and under it the response body: one dark surface that grows downward when an answer arrives. Collapsed, it hugs
// its header like a Dynamic Island; its width eases between that and full width (styles.css .island).
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
  const answerText = state.conversationOpen ? CONVERSATION_LABEL : cardOnly ? (state.meetingCard?.label ?? "Tips") : "Tips";
  // A short meeting notice goes over the answer label too (notch.ts notchLine).
  const line: NotchLine = showResponse && !state.busy && !state.heard && !state.mic.error && !state.meetingNotice ? { kind: "answer", text: answerText } : notchLine(state, isSignedIn);
  const status = line.text;
  // A folded answer opens in full in the island, even under a hint; status that asks for action opens its place in the panel (island-click.ts).
  const click = statusClick({ kind: line.kind, panelOpen: state.expanded, bodyShown: showResponse, answerFolded: answerFolded(state) });
  const newVersion = state.update.check?.available ? state.update.check.latestVersion : null;
  return (
    <div
      className={["island", state.busy && "thinking", showBody && "open"].filter(Boolean).join(" ")}
      style={{ width: state.pillWidth }}
      onPointerEnter={() => actions.setIslandHover(true)}
      onPointerLeave={() => actions.setIslandHover(false)}
    >
      <header className="notch" ref={watchPill}>
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
        {/* Auto-confirm off: Start meeting for a detected call, then Stop meeting for the meeting the user started. */}
        <MeetingButton prompt={state.meetingPrompt} onStart={() => actions.acceptMeeting()} onStop={() => actions.stopMeeting()} />
        <BackgroundChip jobs={state.background} onOpen={() => void actions.openTab("live")} />
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
          card={showResponse ? state.meetingCard : null}
          hint={state.hint}
          hintClosing={state.hintClosing}
          confirm={showResponse ? (state.computer?.confirm ?? null) : null}
          asking={state.asking}
        />
      ) : null}
    </div>
  );
}

function summaryLabel(summary: SummaryState, autoDetect: boolean): string | null {
  if (summary.saving) return "Writing the summary…";
  const result = summary.result;
  if (result) {
    const name = result.path.split(/[\\/]/).pop() ?? result.path;
    return result.usedLlm ? `Saved ${name} to your notes.` : `Saved ${name} without AI. ${result.error ?? ""}`.trim();
  }
  return autoDetect ? null : "Automatic meeting detection is off, so Bee does not start or save meetings.";
}

// Quiet status only: Bee starts and saves meetings by itself (automatic meeting detection), so there is no button. The spoken
// lines are sent to main for the summary but never shown here.
function MeetingSection({ summary, active, autoDetect }: { summary: SummaryState; active: boolean; autoDetect: boolean }) {
  const label = summaryLabel(summary, autoDetect);
  return (
    <section>
      <h2>Meeting</h2>
      {active ? (
        <p className="muted" role="status">
          {MEETING_IN_PROGRESS}
        </p>
      ) : null}
      {label ? <p className="muted">{label}</p> : null}
      {summary.result ? (
        <div className="row actions">
          <Button type="button" variant="link" size="sm" onClick={() => void actions.openSummary()}>
            <IconExternalLink {...ICON} /> Open summary
          </Button>
        </div>
      ) : null}
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

      <BackgroundSection jobs={state.background} onStop={(id) => actions.stopBackground(id)} />

      <MeetingSection summary={state.summary} active={state.meetingActive} autoDetect={state.settings?.autoMeetingDetection === true} />

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
        <TypedCommandForm />
        <form className="simulate" onSubmit={onSubmit}>
          <Input className="h-9" name="line" placeholder="Type a line, or leave blank for a sample" autoComplete="off" />
          <Button type="submit" variant="secondary" size="sm" disabled={state.busy}>
            Simulate meeting line
          </Button>
        </form>
      </section>
    </div>
  );
}

/**
 * Manual test → Talk to Bee (typed): a request through the wake word router, like a mic phrase after speech-to-text, for testing
 * without a microphone. Not a meeting line (that is the form below it), and not a test of audio or speech-to-text. The field
 * empties once Bee takes the request and stays usable while one runs: a newer request replaces it, and "Bee, stop" stops it.
 */
function TypedCommandForm() {
  const [outcome, setOutcome] = useState<TypedCommandOutcome | null>(null);
  const [line, setLine] = useState("");
  const note = typedCommandNote(outcome);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const result = actions.typeCommand(line);
    setOutcome(result);
    if (clearsTypedCommand(result)) setLine("");
  }

  return (
    <div className="flex flex-col gap-1">
      <form className="simulate" onSubmit={onSubmit} aria-label={TYPED_COMMAND_TITLE}>
        <Input
          className="h-9"
          name="command"
          placeholder={TYPED_COMMAND_PLACEHOLDER}
          autoComplete="off"
          aria-describedby="typed-command-hint"
          value={line}
          onChange={(event) => setLine(event.currentTarget.value)}
        />
        <Button type="submit" size="sm">
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

// Settings → "Bee, …" requests: checks the user's Claude Code when Settings opens (ClaudeCodeSection shows it).
function ClaudeCodeStatus({ state }: { state: BeeState }) {
  useEffect(() => {
    void actions.refreshClaudeCode();
  }, []);
  return <ClaudeCodeSection claudeCode={state.claudeCode} update={state.claudeCodeUpdate} onUpdate={() => void actions.updateClaudeCode()} onCheck={() => void actions.refreshClaudeCode(true)} />;
}

// Settings → Browser: checks OpenCode Browse when Settings opens (BrowseSection shows it).
function BrowseStatus({ state }: { state: BeeState }) {
  useEffect(() => {
    void actions.refreshBrowse();
  }, []);
  return <BrowseSection browse={state.browse} install={state.browseInstall} onInstall={() => void actions.installBrowse()} onCheck={() => void actions.refreshBrowse(true)} />;
}

// Settings → computer use: on a Mac, Accessibility for Bee, and Screen Recording for look_at_screen. Computer use never needs it.
function ComputerAccessSection({ access }: { access: BeeState["computerAccess"] }) {
  useEffect(() => {
    void actions.refreshComputerAccess();
  }, []);
  const message = computerAccessMessage(access);
  const screenMessage = screenRecordingMessage(access);
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
      {screenMessage ? (
        <>
          <p className="muted" role="status">
            {screenMessage}
          </p>
          <div className="row actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void recheck(actions.openScreenRecordingSettings)()}>
              Open Screen Recording settings
            </Button>
          </div>
        </>
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
        <KnownNamesField names={settings.knownNames} />
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
      <ShortcutRow
        title="Show or hide Bee"
        shortcut={settings.toggleShortcut}
        defaultShortcut={DEFAULT_TOGGLE_SHORTCUT}
        active={settings.toggleShortcutActive}
        platform={navigator.userAgent.includes("Mac") ? "mac" : "other"}
        onSave={(toggleShortcut) => void actions.saveSettings({ toggleShortcut })}
      />
      <ShortcutRow
        title="Type to Bee"
        shortcut={settings.askShortcut}
        defaultShortcut={DEFAULT_ASK_SHORTCUT}
        active={settings.askShortcutActive}
        platform={navigator.userAgent.includes("Mac") ? "mac" : "other"}
        onSave={(askShortcut) => void actions.saveSettings({ askShortcut })}
      />
      <PreferenceRows settings={settings} onSave={(update) => void actions.saveSettings(update)} />
      <ClaudeCodeStatus state={state} />
      <BrowseStatus state={state} />
      <ComputerAccessSection access={state.computerAccess} />
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
          tabs={[...PANEL_TABS]}
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

/** Background task updates from main (core/background.ts) for the store, for as long as the app runs. */
function useBackgroundUpdates(): void {
  useEffect(() => window.bee.onBackgroundUpdate((job) => actions.backgroundUpdate(job)), []);
}

/** Briefings from main, a couple of minutes before each meeting, for as long as the app runs. */
function useBriefings(): void {
  useEffect(() => window.bee.onBriefing((view) => actions.briefing(view)), []);
}

/** The type-to-Bee shortcut's "open the typing box" from main, for as long as the app runs. */
function useAskOpen(): void {
  useEffect(() => window.bee.onAskOpen(() => actions.openAsk()), []);
}

export function App() {
  const state = useBee();
  useBackgroundUpdates();
  useBriefings();
  useAskOpen();
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
