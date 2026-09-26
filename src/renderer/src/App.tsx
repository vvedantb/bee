import { useState, type FormEvent } from "react";
import type { SettingsView } from "../../shared/ipc";
import { actions, useBee, type BeeState } from "./store";

type Tab = "live" | "settings";

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

function notchStatus(state: BeeState): string {
  if (state.busy) return "Thinking…";
  const tip = state.result?.tips[0];
  if (tip) return tip;
  if (state.settings?.gatewayKeySource === "none") return "Add your AI Gateway key in Settings";
  if (state.transcript.length > 0) return "Listening for something useful…";
  return state.settings?.meetingMode ? "Meeting mode on" : "Bee is ready";
}

function Notch({ state }: { state: BeeState }) {
  return (
    <header className="notch">
      <span className={state.busy ? "notch-dot busy" : "notch-dot"} aria-hidden />
      <span className="notch-status" title={notchStatus(state)}>
        {notchStatus(state)}
      </span>
      <button
        type="button"
        className={state.mic.on ? "icon-button on" : "icon-button"}
        title={state.mic.error ?? (state.mic.on ? "Stop microphone" : "Start microphone")}
        onClick={() => void actions.toggleMic()}
      >
        <span className="mic-level" style={{ transform: `scaleY(${0.2 + state.mic.level * 0.8})` }} />
        Mic
      </button>
      <button
        type="button"
        className="icon-button"
        title={state.expanded ? "Collapse" : "Expand"}
        onClick={() => void actions.setExpanded(!state.expanded)}
      >
        {state.expanded ? "▴" : "▾"}
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
        {state.transcript.length > 0 ? (
          <ol className="transcript">
            {state.transcript.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">Live transcription is stubbed in v1. Use “Simulate meeting line”.</p>
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

function SettingsTab({ settings }: { settings: SettingsView }) {
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const gatewayApiKey = formString(form, "gatewayApiKey");
    const claudeOAuthToken = formString(form, "claudeOAuthToken");
    form.reset();
    void actions.saveSettings({
      gatewayApiKey: gatewayApiKey || undefined,
      claudeOAuthToken: claudeOAuthToken || undefined,
    });
  }

  return (
    <div className="tab-body">
      <form className="settings" onSubmit={onSubmit}>
        <label>
          AI Gateway API key
          <input name="gatewayApiKey" type="password" placeholder="vck_…" autoComplete="off" />
          <span className="muted">{KEY_SOURCE_LABEL[settings.gatewayKeySource]}</span>
        </label>
        <label>
          Claude OAuth token (reserved)
          <input name="claudeOAuthToken" type="password" placeholder="Not used in v1" autoComplete="off" />
          <span className="muted">{settings.hasClaudeToken ? "A token is stored." : "No token stored."}</span>
        </label>
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
  const [tab, setTab] = useState<Tab>("live");
  return (
    <main className="panel">
      <nav className="tabs">
        <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
          Live
        </button>
        <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          Settings
        </button>
      </nav>
      {tab === "live" ? <LiveTab state={state} /> : null}
      {tab === "settings" && state.settings ? <SettingsTab settings={state.settings} /> : null}
    </main>
  );
}

export function App() {
  const state = useBee();
  return (
    <div className={state.expanded ? "shell expanded" : "shell"}>
      <Notch state={state} />
      {state.expanded ? <Panel state={state} /> : null}
    </div>
  );
}
