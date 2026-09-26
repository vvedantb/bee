import { ClerkFailed, Show, SignIn, UserButton, useAuth } from "@clerk/electron/react";
import { IconChevronDown, IconDownload, IconMicrophone, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { SettingsView } from "../../shared/ipc";
import { actions, useBee, type BeeState, type UpdateState } from "./store";

const ICON = { size: 16, stroke: 1.75 };

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

function notchStatus(state: BeeState, signedIn: boolean | undefined): string {
  if (signedIn === undefined) return "Loading…";
  if (!signedIn) return "Sign in to use Bee";
  if (state.busy) return "Thinking…";
  if (state.mic.error) return state.mic.error;
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.mic.on || state.transcript.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}

function Notch({ state }: { state: BeeState }) {
  const { isSignedIn } = useAuth();
  const status = notchStatus(state, isSignedIn);
  const open = state.expanded && !state.collapsing;
  const newVersion = state.update.check?.available ? state.update.check.latestVersion : null;
  return (
    <header className="notch">
      <span className={state.busy ? "notch-dot busy" : "notch-dot"} aria-hidden />
      {/* Keyed so each new status fades in. */}
      <span key={status} className={state.mic.error ? "notch-status error-text" : "notch-status"} title={status}>
        {status}
      </span>
      {newVersion ? (
        <button type="button" className="icon-button accent" title={`Bee ${newVersion} is available`} onClick={() => void actions.openSettings()}>
          <IconDownload {...ICON} />
        </button>
      ) : null}
      <Show when="signed-in">
        <button
          type="button"
          className={state.mic.on ? "icon-button on" : "icon-button"}
          title={state.mic.error ?? (state.mic.on ? "Stop microphone" : "Start microphone")}
          onClick={() => void actions.toggleMic()}
        >
          <IconMicrophone {...ICON} />
          <span className="mic-level" style={{ transform: `scaleY(${0.2 + state.mic.level * 0.8})` }} />
        </button>
      </Show>
      <button
        type="button"
        className={open ? "icon-button chevron open" : "icon-button chevron"}
        title={open ? "Collapse" : "Expand"}
        onClick={() => void actions.setExpanded(!open)}
      >
        <IconChevronDown {...ICON} />
      </button>
    </header>
  );
}

function LiveTab({ state }: { state: BeeState }) {
  const result = state.result;

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
          <p className="muted">{state.busy ? "Thinking…" : "No tips yet."}</p>
        )}
        {result?.guideError ? <p className="error">{result.guideError}</p> : null}
        {state.error ? <p className="error">{state.error}</p> : null}
      </section>

      <form className="simulate" onSubmit={onSubmit}>
        <input name="line" placeholder="Type a line, or leave blank for a sample" autoComplete="off" />
        <button type="submit" disabled={state.busy}>
          Simulate meeting line
        </button>
      </form>

      <section>
        <h2>
          Transcript
          {state.transcript.length > 0 ? (
            <button type="button" className="link" onClick={actions.clearTranscript}>
              Clear
            </button>
          ) : null}
        </h2>
        {state.mic.error ? <p className="error">{state.mic.error}</p> : null}
        {state.transcript.length > 0 || state.mic.interim ? (
          <ol className="transcript">
            {state.transcript.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
            {state.mic.interim ? <li className="interim">{state.mic.interim}</li> : null}
          </ol>
        ) : (
          <p className="muted">{state.mic.on ? "Listening…" : "Turn on the mic, or type a line and click “Simulate meeting line”."}</p>
        )}
      </section>

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

// Saved secrets never reach the renderer, so a saved field shows placeholder dots until the user replaces it.
function SecretField(props: { name: string; label: string; placeholder: string; saved: boolean; status: string }) {
  const [replacing, setReplacing] = useState(false);
  const masked = props.saved && !replacing;
  return (
    <label>
      {props.label}
      <span className="row">
        {masked ? (
          <input type="text" value="•••••••• (saved)" disabled aria-label={`${props.label} (saved)`} />
        ) : (
          <input
            name={props.name}
            type="password"
            placeholder={props.saved ? "Paste a new value" : props.placeholder}
            autoComplete="off"
            autoFocus={replacing}
          />
        )}
        {props.saved ? (
          <button type="button" className="link" onClick={() => setReplacing(!replacing)}>
            {replacing ? "Cancel" : "Replace"}
          </button>
        ) : null}
      </span>
      <span className="muted">{props.status}</span>
    </label>
  );
}

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
          <button type="button" className="primary" onClick={() => void actions.installUpdate()}>
            <IconPlayerPlay {...ICON} /> Quit &amp; install
          </button>
        ) : check?.available ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void actions.downloadUpdate()}>
            <IconDownload {...ICON} /> Download update
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void actions.checkForUpdate()}>
          <IconRefresh {...ICON} className={update.status === "checking" ? "spin" : undefined} /> Check for updates
        </button>
        {check?.releaseUrl ? (
          <a className="link" href={check.releaseUrl} target="_blank" rel="noreferrer">
            Release notes
          </a>
        ) : null}
      </div>
    </section>
  );
}

function SettingsTab({ settings, update, error }: { settings: SettingsView; update: UpdateState; error: string | null }) {
  // Remounting the form after a save clears typed secrets and returns saved fields to their masked state.
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const gatewayApiKey = formString(form, "gatewayApiKey");
    const claudeOAuthToken = formString(form, "claudeOAuthToken");
    const saved = await actions.saveSettings({
      gatewayApiKey: gatewayApiKey || undefined,
      claudeOAuthToken: claudeOAuthToken || undefined,
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
        <SecretField
          name="claudeOAuthToken"
          label="Claude OAuth token (reserved)"
          placeholder="Not used in v1"
          saved={settings.hasClaudeToken}
          status={settings.hasClaudeToken ? "A token is stored." : "No token stored."}
        />
        {error ? <p className="error">{error}</p> : null}
        <div className="row">
          <button type="submit">Save</button>
          {settings.gatewayKeySource === "saved" ? (
            <button type="button" className="link" onClick={() => void actions.saveSettings({ gatewayApiKey: "" })}>
              Remove saved key
            </button>
          ) : null}
          {settings.hasClaudeToken ? (
            <button type="button" className="link" onClick={() => void actions.saveSettings({ claudeOAuthToken: "" })}>
              Remove token
            </button>
          ) : null}
        </div>
      </form>

      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.meetingMode}
          onChange={(event) => void actions.saveSettings({ meetingMode: event.currentTarget.checked })}
        />
        Meeting mode (hide Bee from screen sharing, stay above full-screen apps)
      </label>

      <UpdateSection update={update} />

      <p className="muted">{STORAGE_LABEL[settings.secretStorage]}</p>
      <p className="muted">
        Notes folder: <code>{settings.notesDir}</code>{" "}
        <button type="button" className="link" onClick={() => void window.bee.openNotesFolder()}>
          Open
        </button>
      </p>
    </div>
  );
}

function Panel({ state }: { state: BeeState }) {
  return (
    <main className="panel">
      <nav className="tabs">
        <button type="button" className={state.tab === "live" ? "active" : ""} onClick={() => actions.setTab("live")}>
          Live
        </button>
        <button type="button" className={state.tab === "settings" ? "active" : ""} onClick={() => actions.setTab("settings")}>
          Settings
        </button>
        <span className="tabs-account">
          <UserButton />
        </span>
      </nav>
      {state.tab === "live" ? <LiveTab state={state} /> : null}
      {state.tab === "settings" && state.settings ? <SettingsTab settings={state.settings} update={state.update} error={state.error} /> : null}
    </main>
  );
}

export function App() {
  const state = useBee();
  return (
    <div className={["shell", state.expanded && "expanded", state.collapsing && "collapsing"].filter(Boolean).join(" ")}>
      <Notch state={state} />
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
