import { ClerkFailed, Show, SignIn, UserButton, useAuth } from "@clerk/electron/react";
import {
  IconChevronDown,
  IconDownload,
  IconExternalLink,
  IconMicrophone,
  IconMicrophoneOff,
  IconNotebook,
  IconPlayerPlay,
  IconRefresh,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { Button, Input, LabeledSwitchRow, Textarea } from "@vvedantb/ui";
import { PillTabs } from "@vvedantb/shell";
import { useEffect, useState, type FormEvent } from "react";
import { Favicon } from "./Favicon";
import { Connectors } from "./Connectors";
import { SecretField } from "./SecretField";
import { INTERFACE_SCALES } from "../../core/interface-scale";
import { DEFAULT_MOTION_PREFERENCE, MOTION_PREFERENCES, resolveReducedMotion, type MotionPreference } from "../../core/motion-preference";
import { visibleChips, type LinkChip } from "../../core/link-suggest";
import type { PipelineResult, SettingsView } from "../../shared/ipc";
import { activityLabel } from "./island";
import { actions, islandOpen, useBee, type BeeState, type SummaryState, type UpdateState } from "./store";
import { SyncCard, SyncSection, TeamSection, syncedWith } from "./Teams";

const ICON = { size: 16, stroke: 1.75 };

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  if (signedIn === undefined) return "Loading…";
  if (!signedIn) return "Sign in to use Bee";
  if (state.busy) return activityLabel(state.activity);
  if (state.mic.error) return state.mic.error;
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.mic.on || state.session.lines.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}

// Suggestions only: a click asks main to open the link in the default browser. Nothing opens by itself.
function LinkChips({ chips }: { chips: LinkChip[] }) {
  if (chips.length === 0) return null;
  return (
    <ul className="link-chips" aria-label="Suggested links">
      {chips.map((chip) => (
        <li key={chip.id} className="chip link-chip">
          <Button type="button" variant="link" className="h-6 gap-1.5 rounded-full py-0 pr-1 pl-2.5 text-[13px] no-underline" title={chip.url} onClick={() => void actions.openLink(chip.url)}>
            <Favicon domain={chip.domain} />
            {chip.label}
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" className="size-6 rounded-full" title="Dismiss link" aria-label={`Dismiss ${chip.label}`} onClick={() => actions.dismissChip(chip.id)}>
            <IconX size={12} stroke={2} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function IslandBody({ result, chips, closing }: { result: PipelineResult | null; chips: LinkChip[]; closing: boolean }) {
  const tips = result?.tips ?? [];
  const sources = result?.sources ?? [];
  return (
    <section className={closing ? "island-body closing" : "island-body"} aria-live="polite">
      <div className="island-inner">
        <Button type="button" variant="ghost" size="icon-sm" className="island-close" title="Dismiss" aria-label="Dismiss" onClick={() => void actions.dismissIsland()}>
          <IconX {...ICON} />
        </Button>
        {tips.length > 0 ? (
          <ul className="island-tips">
            {tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        ) : null}
        <LinkChips chips={chips} />
        {result?.guideError ? <p className="island-error">{result.guideError}</p> : null}
        {result?.guideNote ? <p className="island-note">{result.guideNote}</p> : null}
        {sources.length > 0 ? (
          <div className="island-sources">
            <h3>Sources</h3>
            <ul>
              {sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// The pill, and under it the response body: one dark surface that grows downward when an answer arrives.
function Island({ state }: { state: BeeState }) {
  const { isSignedIn } = useAuth();
  const open = state.expanded && !state.collapsing;
  const result = state.result;
  const chips = visibleChips(state.chips, state.dismissedChipIds);
  const showBody = islandOpen(state);
  // Collapsed, the status text opens the panel like the chevron, whatever it says.
  const canExpand = !state.expanded;
  // While Luna thinks, chips may open the body but the pill keeps its thinking text.
  const status = showBody && !state.busy && !state.mic.error ? "Tips" : notchStatus(state, isSignedIn);
  const newVersion = state.update.check?.available ? state.update.check.latestVersion : null;
  const statusClass = state.mic.error ? "notch-status error-text" : "notch-status";
  return (
    <div
      className={["island", state.busy && "thinking", showBody && "open"].filter(Boolean).join(" ")}
      onPointerEnter={() => actions.setIslandHover(true)}
      onPointerLeave={() => actions.setIslandHover(false)}
    >
      <header className="notch">
        <span className={state.busy ? "notch-dot busy" : "notch-dot"} aria-hidden />
        {canExpand ? (
          // Keyed so each new status fades in.
          <Button
            key={status}
            type="button"
            variant="ghost"
            title={status}
            className={`${statusClass} h-auto justify-start rounded-none p-0 text-[13px] font-normal text-foreground hover:bg-transparent hover:text-foreground hover:underline`}
            onClick={() => void actions.setExpanded(true)}
          >
            {status}
          </Button>
        ) : (
          <span key={status} className={statusClass} title={status}>
            {status}
          </span>
        )}
        {newVersion ? (
          <Button type="button" variant="ghost" size="icon-sm" className="pill-button notch-update" title={`Bee ${newVersion} is available`} onClick={() => void actions.openSettings()}>
            <IconDownload {...ICON} />
          </Button>
        ) : null}
        {state.teams?.room ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="sync-chip rounded-full"
            title={`${syncedWith(state.teams)}${state.teams.shareMuted ? " · sharing paused" : ""}`}
            onClick={() => {
              actions.setTab("live");
              if (!open) void actions.setExpanded(true);
            }}
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
            className={state.mic.on ? "pill-button on rounded-full" : "pill-button rounded-full"}
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
          className={open ? "pill-button chevron open rounded-full" : "pill-button chevron rounded-full"}
          title={open ? "Collapse" : "Expand"}
          onClick={() => void actions.setExpanded(!open)}
        >
          <IconChevronDown {...ICON} />
        </Button>
      </header>
      {/* While busy, pass no result: the body shows only the new chips, never the previous turn's tips, sources or error. */}
      {showBody ? <IslandBody result={state.busy ? null : result} chips={chips} closing={state.islandClosing} /> : null}
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

// The spoken lines are sent to main for the summary but never shown here.
function MeetingSection({ summary, lineCount }: { summary: SummaryState; lineCount: number }) {
  return (
    <section>
      <h2>Meeting</h2>
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
  const result = state.result;
  const chips = visibleChips(state.chips, state.dismissedChipIds);

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
            {result.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{state.busy ? "Thinking…" : state.mic.on ? "Listening…" : "No tips yet. Turn on the mic to start."}</p>
        )}
        <LinkChips chips={chips} />
        {result && result.sources.length > 0 ? (
          <div className="sources">
            <span className="muted">Sources</span>
            <ul>
              {result.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.mic.error ? <p className="error">{state.mic.error}</p> : null}
        {result?.guideError ? <p className="error">{result.guideError}</p> : null}
        {state.error ? <p className="error">{state.error}</p> : null}
      </section>

      <SyncSection state={state} />

      <MeetingSection summary={state.summary} lineCount={state.session.lines.length} />

      <section>
        <h2>
          Notes
          {result ? (
            <span className="badge">
              {result.rankSource === "jev" ? "ranked by Jev" : "retrieval order"} ·{" "}
              {Math.round(result.timingsMs.rank + result.timingsMs.guide)} ms
            </span>
          ) : null}
        </h2>
        {result?.rankError ? <p className="error">{result.rankError}</p> : null}
        {result && result.notes.length > 0 ? (
          <ul className="notes">
            {result.notes.map((note) => (
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
          <p className="muted">{result ? "No matching notes." : "Matching notes appear here."}</p>
        )}
      </section>

      {/* Manual test: runs the same pipeline as a spoken phrase. The line is not kept on screen. */}
      <section>
        <h2>Manual test</h2>
        <form className="simulate" onSubmit={onSubmit}>
          <Input className="h-9" name="line" placeholder="Type a line, or leave blank for a sample" autoComplete="off" />
          <Button type="submit" variant="secondary" size="sm" disabled={state.busy}>
            Simulate meeting line
          </Button>
        </form>
        {state.teams?.team ? (
          <div className="switch-row">
            <LabeledSwitchRow
              id="simulate-teams"
              label="Simulate Teams meeting (the sync popup shows after about 10 s)"
              checked={state.teams.detection.source === "simulated"}
              onCheckedChange={(on) => void actions.teams({ type: "simulateMeeting", on })}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

const STORAGE_LABEL: Record<SettingsView["secretStorage"], string> = {
  os: "Secrets are encrypted with the operating system key store.",
  weak: "No OS keyring found: secrets use Electron's weak fallback encryption.",
  memory: "Encryption unavailable: secrets are kept in memory for this session only.",
};

const KEY_SOURCE_LABEL: Record<SettingsView["gatewayKeySource"], string> = {
  saved: "A key is set in Settings and is in use.",
  env: "Using BEE_AI_GATEWAY_API_KEY from the environment.",
  none: "No key set.",
};

function updateLabel(update: UpdateState): string {
  if (update.status === "checking") return "Checking for updates…";
  if (update.status === "downloading") return "Downloading update…";
  if (update.status === "ready") return "Update downloaded. Bee will quit while the installer runs.";
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
    });
    if (saved) setFormKey(formKey + 1);
  }

  return (
    <div className="tab-body">
      <form key={formKey} className="settings" onSubmit={(event) => void onSubmit(event)}>
        <SecretField
          name="gatewayApiKey"
          label="AI Gateway API key"
          placeholder="vck_…"
          saved={settings.gatewayKeySource === "saved"}
          status={KEY_SOURCE_LABEL[settings.gatewayKeySource]}
        />
        <label>
          Extra folders Luna may read (one absolute path per line)
          <Textarea name="fsRoots" rows={3} defaultValue={settings.fsRoots.join("\n")} spellCheck={false} />
        </label>
        <p className="muted">
          Notes folder: <code>{settings.notesDir}</code>{" "}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void window.bee.openNotesFolder()}>
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

      <div className="switch-row">

        <LabeledSwitchRow
          id="personalised-links"
          label="Personalised link suggestions"
          description="Sends the current line to Jev, and to vmem when connected under Connectors, to pick the exact page. Needs the Gateway key."
          checked={settings.personalisedLinks}
          onCheckedChange={(personalisedLinks) => void actions.saveSettings({ personalisedLinks })}
        />

      </div>

      <div className="switch-row">

        <LabeledSwitchRow
          id="meeting-mode"
          label="Meeting mode"
          description="Hide Bee from screen sharing, stay above full-screen apps."
          checked={settings.meetingMode}
          onCheckedChange={(meetingMode) => void actions.saveSettings({ meetingMode })}
        />

      </div>

      <div className="field">
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

      <div className="field">
        Animations
        <PillTabs
          tabs={MOTION_PREFERENCES.map((preference) => ({ value: preference, label: MOTION_LABEL[preference] }))}
          value={settings.motionPreference}
          onValueChange={(value) => {
            const motionPreference = MOTION_PREFERENCES.find((preference) => preference === value);
            if (motionPreference) void actions.saveSettings({ motionPreference });
          }}
        />
        <p className="muted">On keeps Bee's motion even when Windows or macOS reduces animations. System follows the OS. Off skips motion.</p>
      </div>

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

export function App() {
  const state = useBee();
  useMotionAttribute(state.settings?.motionPreference ?? DEFAULT_MOTION_PREFERENCE);
  return (
    <div className={["shell", state.expanded && "expanded", state.collapsing && "collapsing"].filter(Boolean).join(" ")}>
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
