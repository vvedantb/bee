import { IconPlug } from "@tabler/icons-react";
import { Button, Checkbox, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@vvedantb/ui";
import { useState, type FormEvent } from "react";
import type { McpSave, McpServerView } from "../../shared/ipc";
import { isEvaConnector, isVmemConnector } from "../../shared/mcp-names";
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
        <Input className="h-9" name="name" defaultValue={server?.name} placeholder="vmem" maxLength={40} required spellCheck={false} />
        <span className="muted">Luna sees its tools as name__tool.</span>
      </label>
      <label>
        Transport
        <Select value={transport} onValueChange={(value) => setTransport(value as Transport)}>
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http">Streamable HTTP (remote)</SelectItem>
            <SelectItem value="stdio">stdio (local command)</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {transport === "http" ? (
        <>
          <label>
            URL
            <Input className="h-9" name="url" defaultValue={server?.url} placeholder="https://clear-bear-690.eu-west-1.convex.site/mcp" required spellCheck={false} />
            <span className="muted">https, or http on localhost.</span>
          </label>
          <label>
            Authentication
            <Select value={authType} onValueChange={(value) => setAuthType(value as AuthType)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="header">Custom header</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {authType === "header" ? (
            <label>
              Header name
              <Input className="h-9" name="headerName" defaultValue={server?.auth.headerName} placeholder="X-API-Key" spellCheck={false} />
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
            <Input className="h-9" name="command" defaultValue={server?.command} placeholder="npx" required spellCheck={false} />
          </label>
          <label>
            Arguments (one per line, or separated by spaces)
            <Textarea name="args" rows={3} defaultValue={server?.args?.join("\n")} placeholder={"-y\n@scope/server"} spellCheck={false} />
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
        <Button type="submit" size="sm">
          {server ? "Save server" : "Add server"}
        </Button>
        <Button type="button" variant="link" size="sm" onClick={onDone}>
          Cancel
        </Button>
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
            <Checkbox
              checked={item.enabled}
              onCheckedChange={(checked) => void actions.setMcpEnabled({ id: server.id, tool: item.name, enabled: checked === true })}
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
        <Button type="button" variant="secondary" size="sm" disabled={test?.busy} onClick={() => void actions.testMcpServer(server.id)}>
          Test connection
        </Button>
      </div>
      {status ? <p className={status.failed ? "error" : "muted"}>{status.text}</p> : null}
      <McpToolList server={server} />
    </div>
  );
}

// Connectors Bee offers by name. Connect saves the server enabled and signs in through the system browser (MCP OAuth).
type Preset = { name: string; url: string; domain: string; matches: (server: McpServerView) => boolean };
const PRESETS: Preset[] = [
  { name: "vmem", url: "https://clear-bear-690.eu-west-1.convex.site/mcp", domain: "vmem.projectv.uk", matches: isVmemConnector },
  { name: "Eva", url: "https://dazzling-dogfish-581.eu-west-1.convex.site/mcp", domain: "eva.vedantb.com", matches: isEvaConnector },
];

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
        <Button type="button" variant="ghost" className="connector-main h-auto justify-start gap-2.5 p-0 text-foreground hover:bg-transparent" onClick={onOpen}>
          {label}
        </Button>
      ) : (
        <span className="connector-main">{label}</span>
      )}
      <Button type="button" variant={connected ? "ghost" : "default"} size="sm" disabled={busy} onClick={onToggle}>
        {connected ? "Disconnect" : "Connect"}
      </Button>
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

  // Connect saves a preset enabled when it is new, then signs in. Disconnect removes the server and its tokens, so Connect is a fresh add.
  const connectPreset = (preset: Preset, saved: McpServerView | undefined) =>
    actions.connectMcpServer({ name: preset.name, enabled: true, transport: "http", url: preset.url, auth: { type: "none" } }, saved?.id);

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
          // Signed in, not just saved: a server that is enabled but has no tokens still offers Connect.
          const connected = Boolean(saved?.enabled && saved.hasAuth);
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
        {custom.map((server) => {
          // An HTTP server with no stored secret signs in with OAuth, like a preset; other rows just switch on and off.
          const oauth = server.transport === "http" && server.auth.type === "none";
          const connected = oauth ? server.enabled && server.hasAuth : server.enabled;
          const connect = () =>
            oauth
              ? actions.connectMcpServer({ name: server.name, enabled: true, transport: "http", url: server.url, auth: { type: "none" } }, server.id)
              : actions.setMcpEnabled({ id: server.id, enabled: true });
          return (
            <ConnectorRow
              key={server.id}
              name={server.name}
              domain={server.transport === "http" ? hostOf(server.url) : null}
              connected={connected}
              busy={busy === server.id}
              onToggle={() => void run(server.id, () => (connected ? actions.removeMcpServer(server.id) : connect()))}
              onOpen={() => setEditing(server.id)}
            />
          );
        })}
      </ul>
      {props.error ? <p className="error">{props.error}</p> : null}
      <div className="actions row">
        <Button type="button" variant="link" size="sm" onClick={() => setEditing("new")}>
          Add custom
        </Button>
      </div>
    </section>
  );
}
