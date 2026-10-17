import { IconPlug } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { McpSave, McpServerView } from "../../shared/ipc";
import { isVmemConnector } from "../../shared/mcp-names";
import { Favicon } from "./Favicon";
import { SecretField } from "./SecretField";
import { actions, type McpTestState } from "./store";

type Transport = McpServerView["transport"];
type AuthType = McpServerView["auth"]["type"];

function formString(form: HTMLFormElement, name: string): string | undefined {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : undefined;
}

function testLabel(test: McpTestState): { text: string; failed: boolean } | null {
  if (test.busy) return { text: "Connecting…", failed: false };
  if (!test.result) return null;
  if (!test.result.ok) return { text: test.result.error ?? "Connection failed", failed: true };
  const count = test.result.tools?.length ?? 0;
  return { text: `Connected. ${count} ${count === 1 ? "tool" : "tools"}.`, failed: false };
}

// Add or edit one server. The secret fields are left out of the save unless the user types a new value.
function McpForm({ server, error, onDone }: { server: McpServerView | null; error: string | null; onDone: () => void }) {
  const [transport, setTransport] = useState<Transport>(server?.transport ?? "http");
  const [authType, setAuthType] = useState<AuthType>(server?.auth.type ?? "none");
  // A saved secret only fits the auth style it was saved with.
  const savedAuth = Boolean(server?.hasAuth) && server?.auth.type === authType;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const save: McpSave = {
      id: server?.id,
      name: formString(form, "name") ?? "",
      enabled: server?.enabled ?? true,
      transport,
      auth: { type: "none" },
    };
    if (transport === "http") {
      save.url = formString(form, "url");
      save.auth = { type: authType, headerName: authType === "header" ? formString(form, "headerName") : undefined };
      save.secret = formString(form, "secret") || undefined;
    } else {
      save.command = formString(form, "command");
      save.args = formString(form, "args");
      save.env = formString(form, "env") || undefined;
    }
    if (await actions.saveMcpServer(save)) onDone();
  }

  return (
    <form className="settings mcp-form" onSubmit={(event) => void onSubmit(event)}>
      <label>
        Name
        <input name="name" defaultValue={server?.name} placeholder="vmem" maxLength={40} required spellCheck={false} />
        <span className="muted">Luna sees its tools as name__tool.</span>
      </label>
      <label>
        Transport
        <select value={transport} onChange={(event) => setTransport(event.currentTarget.value as Transport)}>
          <option value="http">Streamable HTTP (remote)</option>
          <option value="stdio">stdio (local command)</option>
        </select>
      </label>
      {transport === "http" ? (
        <>
          <label>
            URL
            <input name="url" defaultValue={server?.url} placeholder="https://clear-bear-690.eu-west-1.convex.site/mcp" required spellCheck={false} />
            <span className="muted">https, or http on localhost.</span>
          </label>
          <label>
            Authentication
            <select value={authType} onChange={(event) => setAuthType(event.currentTarget.value as AuthType)}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          {authType === "header" ? (
            <label>
              Header name
              <input name="headerName" defaultValue={server?.auth.headerName} placeholder="X-API-Key" spellCheck={false} />
            </label>
          ) : null}
          {authType !== "none" ? (
            <SecretField
              key={authType}
              name="secret"
              label={authType === "bearer" ? "Token" : "Header value"}
              placeholder={authType === "bearer" ? "Paste a token" : "Paste the value"}
              saved={savedAuth}
              status={savedAuth ? "A value is stored." : "For OAuth servers, authorise elsewhere and paste the token here."}
            />
          ) : null}
        </>
      ) : (
        <>
          <label>
            Command
            <input name="command" defaultValue={server?.command} placeholder="npx" required spellCheck={false} />
          </label>
          <label>
            Arguments (one per line, or separated by spaces)
            <textarea name="args" rows={3} defaultValue={server?.args?.join("\n")} placeholder={"-y\n@scope/server"} spellCheck={false} />
          </label>
          <SecretField
            name="env"
            label="Environment (KEY=value, one per line)"
            placeholder={"API_KEY=…"}
            multiline
            saved={Boolean(server?.envKeys.length)}
            status={server?.envKeys.length ? `Saved keys: ${server.envKeys.join(", ")}` : "Optional. Values are stored encrypted."}
          />
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <button type="submit">{server ? "Save server" : "Add server"}</button>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function McpToolList({ server }: { server: McpServerView }) {
  if (!server.tools?.length) return null;
  return (
    <ul className="mcp-tools">
      {server.tools.map((item) => (
        <li key={item.name}>
          <label className="toggle" title={item.description}>
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(event) => void actions.setMcpEnabled({ id: server.id, tool: item.name, enabled: event.currentTarget.checked })}
            />
            <code>{item.name}</code>
          </label>
        </li>
      ))}
    </ul>
  );
}

// The details of one custom connector: test the connection, switch tools. Only reached by clicking the row.
function McpDetails({ server, test }: { server: McpServerView; test: McpTestState | undefined }) {
  const status = test ? testLabel(test) : null;
  return (
    <div className="mcp-details">
      <div className="row">
        <button type="button" disabled={test?.busy} onClick={() => void actions.testMcpServer(server.id)}>
          Test connection
        </button>
      </div>
      {status ? <p className={status.failed ? "error" : "muted"}>{status.text}</p> : null}
      <McpToolList server={server} />
    </div>
  );
}

// Connectors Bee offers by name. Connect saves the server enabled; none of these needs a token.
type Preset = { name: string; url: string; domain: string; matches: (server: McpServerView) => boolean };
const PRESETS: Preset[] = [{ name: "vmem", url: "https://clear-bear-690.eu-west-1.convex.site/mcp", domain: "vmem.vedantb.com", matches: isVmemConnector }];

function hostOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? "").hostname || null;
  } catch {
    return null;
  }
}

function ConnectorIcon({ domain }: { domain: string | null }) {
  return <span className="connector-icon">{domain ? <Favicon domain={domain} /> : <IconPlug size={14} stroke={1.75} aria-hidden />}</span>;
}

type ConnectorRowProps = { name: string; domain: string | null; connected: boolean; busy: boolean; onToggle: () => void; onOpen?: () => void };

// One line: icon, name, Connect or Disconnect. A custom row's name opens its edit panel.
function ConnectorRow({ name, domain, connected, busy, onToggle, onOpen }: ConnectorRowProps) {
  const label = (
    <>
      <ConnectorIcon domain={domain} />
      <strong>{name}</strong>
    </>
  );
  return (
    <li className="connector">
      {onOpen ? (
        <button type="button" className="connector-main" onClick={onOpen}>
          {label}
        </button>
      ) : (
        <span className="connector-main">{label}</span>
      )}
      <button type="button" className={connected ? "connector-disconnect" : "primary"} disabled={busy} onClick={onToggle}>
        {connected ? "Disconnect" : "Connect"}
      </button>
    </li>
  );
}

/** The Connectors tab: one clean row per connector, with advanced setup behind Add custom or a custom row. Secrets never come back. */
export function Connectors(props: { servers: McpServerView[]; tests: Record<string, McpTestState>; error: string | null }) {
  // "new", a server id, or null (list only).
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const editingServer = props.servers.find((server) => server.id === editing) ?? null;

  async function run(key: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  }

  // Connect saves a preset enabled, or switches a saved one back on. Disconnect removes the server, so Connect is always a fresh add.
  const connectPreset = (preset: Preset, saved: McpServerView | undefined) =>
    saved
      ? actions.setMcpEnabled({ id: saved.id, enabled: true })
      : actions.saveMcpServer({ name: preset.name, enabled: true, transport: "http", url: preset.url, auth: { type: "none" } });

  if (editing) {
    return (
      <section>
        <h2>{editingServer ? editingServer.name : "Add custom connector"}</h2>
        {/* Remount per target so each form starts from its own saved values. */}
        <McpForm key={editing} server={editingServer} error={props.error} onDone={() => setEditing(null)} />
        {editingServer ? <McpDetails server={editingServer} test={props.tests[editingServer.id]} /> : null}
      </section>
    );
  }

  const custom = props.servers.filter((server) => !PRESETS.some((preset) => preset.matches(server)));
  return (
    <section>
      <h2>Connectors</h2>
      <ul className="connector-list">
        {PRESETS.map((preset) => {
          const saved = props.servers.find(preset.matches);
          const connected = Boolean(saved?.enabled);
          return (
            <ConnectorRow
              key={preset.name}
              name={preset.name}
              domain={preset.domain}
              connected={connected}
              busy={busy === preset.name}
              onToggle={() => void run(preset.name, () => (connected && saved ? actions.removeMcpServer(saved.id) : connectPreset(preset, saved)))}
            />
          );
        })}
        {custom.map((server) => (
          <ConnectorRow
            key={server.id}
            name={server.name}
            domain={server.transport === "http" ? hostOf(server.url) : null}
            connected={server.enabled}
            busy={busy === server.id}
            onToggle={() => void run(server.id, () => (server.enabled ? actions.removeMcpServer(server.id) : actions.setMcpEnabled({ id: server.id, enabled: true })))}
            onOpen={() => setEditing(server.id)}
          />
        ))}
      </ul>
      {props.error ? <p className="error">{props.error}</p> : null}
      <div className="actions row">
        <button type="button" className="link" onClick={() => setEditing("new")}>
          Add custom
        </button>
      </div>
    </section>
  );
}
