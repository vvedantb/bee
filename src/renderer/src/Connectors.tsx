import { Avatar, AvatarFallback, AvatarImage, Button, Checkbox, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@vvedantb/ui";
import { useEffect, useState, type FormEvent } from "react";
import type { McpSave, McpServerView } from "../../shared/ipc";
import { faviconHostOf, safeIconSrc } from "../../shared/mcp-icons";
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
      // Sent every time, so an emptied box clears the override.
      save.iconOverride = formString(form, "iconOverride")?.trim() ?? "";
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
        <Input className="h-9" name="name" defaultValue={server?.name} placeholder="My server" maxLength={40} required spellCheck={false} />
        <span className="muted">The AI sees its tools as name__tool.</span>
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
            <Input className="h-9" name="url" defaultValue={server?.url} placeholder="https://example.com/mcp" required spellCheck={false} />
            <span className="muted">https, or http on localhost.</span>
          </label>
          <label>
            Icon URL (optional)
            <Input className="h-9" name="iconOverride" defaultValue={server?.iconOverride} placeholder="https://example.com/icon.png" spellCheck={false} />
            <span className="muted">https or data:image. Leave empty to use the icon the server provides.</span>
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
              status={savedAuth ? "A value is stored." : "OAuth: authorise elsewhere, then paste the token."}
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
          <label className="flex items-center gap-2" title={item.description}>
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

// The details of one custom connector: test the connection, switch tools, remove it. Only reached by clicking the row.
function McpDetails({ server, test, onRemoved }: { server: McpServerView; test: McpTestState | undefined; onRemoved: () => void }) {
  const status = test ? testLabel(test) : null;
  // Remove works in any state (connected or not). The first click asks, the second removes.
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRemoving(true);
    const removed = await actions.removeMcpServer(server.id);
    setRemoving(false);
    setConfirming(false);
    if (removed) onRemoved();
  }

  return (
    <div className="mcp-details">
      <div className="row">
        <Button type="button" variant="secondary" size="sm" disabled={test?.busy} onClick={() => void actions.testMcpServer(server.id)}>
          Test connection
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={removing} onClick={() => void remove()} onBlur={() => setConfirming(false)}>
          {confirming ? "Click again to remove" : "Remove connector"}
        </Button>
      </div>
      {status ? <p className={status.failed ? "error" : "muted"}>{status.text}</p> : null}
      <McpToolList server={server} />
    </div>
  );
}

// Favicons by host and https icon URLs, as data URLs from main (CSP allows no remote images). Remembered for this window.
const favicons = new Map<string, Promise<string | null>>();
function faviconFor(host: string): Promise<string | null> {
  let icon = favicons.get(host);
  if (!icon) {
    icon = window.bee.getFavicon(host).catch(() => null);
    favicons.set(host, icon);
  }
  return icon;
}
const httpsIcons = new Map<string, Promise<string | null>>();
function httpsIconFor(url: string): Promise<string | null> {
  let icon = httpsIcons.get(url);
  if (!icon) {
    icon = window.bee.getHttpsIcon(url).catch(() => null);
    httpsIcons.set(url, icon);
  }
  return icon;
}

/**
 * A connector's icon: the user's Icon URL, else the icon the server reported (serverInfo.icons), else the favicon of its
 * website, else of its URL host (not *.convex.site), else the first letter of its name. https: srcs are fetched in main.
 */
function ConnectorIcon({ server }: { server: McpServerView }) {
  const direct = safeIconSrc(server.iconOverride) ?? safeIconSrc(server.iconUrl);
  const httpsDirect = direct?.startsWith("https:") ? direct : null;
  const dataDirect = direct?.startsWith("data:") ? direct : null;
  const hosts = dataDirect || httpsDirect ? [] : [faviconHostOf(server.websiteUrl), server.transport === "http" ? faviconHostOf(server.url) : null].filter((host): host is string => Boolean(host));
  const hostKey = [...new Set(hosts)].join(" ");
  const [resolved, setResolved] = useState<string | null>(dataDirect);
  useEffect(() => {
    let live = true;
    setResolved(dataDirect);
    if (dataDirect) return;
    void (async () => {
      if (httpsDirect) {
        const icon = await httpsIconFor(httpsDirect);
        if (live) setResolved(icon);
        return;
      }
      for (const host of hostKey ? hostKey.split(" ") : []) {
        const icon = await faviconFor(host);
        if (icon) {
          if (live) setResolved(icon);
          return;
        }
      }
      if (live) setResolved(null);
    })();
    return () => {
      live = false;
    };
  }, [dataDirect, httpsDirect, hostKey]);
  return (
    <Avatar className="connector-icon h-5 w-5 rounded-md border-0 bg-transparent">
      {resolved ? <AvatarImage src={resolved} alt="" className="object-contain" /> : null}
      <AvatarFallback className="rounded-md text-[11px] font-semibold uppercase">{server.name.trim().charAt(0) || "?"}</AvatarFallback>
    </Avatar>
  );
}

type ConnectorRowProps = { server: McpServerView; connected: boolean; busy: boolean; onToggle: () => void; onOpen: () => void };

// One line: icon, name, Connect or Disconnect. The name opens the edit panel.
function ConnectorRow({ server, connected, busy, onToggle, onOpen }: ConnectorRowProps) {
  return (
    <li className="connector">
      <Button type="button" variant="ghost" className="connector-main h-auto justify-start gap-2.5 p-0 text-foreground hover:bg-transparent" onClick={onOpen}>
        <ConnectorIcon server={server} />
        <strong>{server.name}</strong>
      </Button>
      <Button type="button" variant={connected ? "ghost" : "default"} size="sm" disabled={busy} onClick={onToggle}>
        {connected ? "Disconnect" : "Connect"}
      </Button>
    </li>
  );
}

/** The Connectors tab: one row per saved server, with setup behind Add custom or a click on a row. Secrets never come back. */
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

  if (editing) {
    return (
      <section>
        <h2>{editingServer ? editingServer.name : "Add custom connector"}</h2>
        {/* Remount per target so each form starts from its own saved values. */}
        <McpForm key={editing} server={editingServer} error={props.error} onDone={() => setEditing(null)} />
        {editingServer ? <McpDetails server={editingServer} test={props.tests[editingServer.id]} onRemoved={() => setEditing(null)} /> : null}
      </section>
    );
  }

  return (
    <section>
      <h2>Connectors</h2>
      <ul className="connector-list">
        {props.servers.map((server) => {
          // An HTTP server with auth "none" signs in with MCP OAuth and counts as connected once tokens are stored; other rows just switch on and off.
          // Disconnect keeps the saved server: sign-in servers revoke and drop their tokens and switch off, others just switch off.
          // Removing the server is in its details view.
          const oauth = server.transport === "http" && server.auth.type === "none";
          const connected = oauth ? server.enabled && server.hasAuth : server.enabled;
          const connect = () =>
            oauth
              ? actions.connectMcpServer({ name: server.name, enabled: true, transport: "http", url: server.url, auth: { type: "none" } }, server.id)
              : actions.setMcpEnabled({ id: server.id, enabled: true });
          const disconnect = () => (oauth ? actions.signOutMcpServer(server.id) : actions.setMcpEnabled({ id: server.id, enabled: false }));
          return (
            <ConnectorRow
              key={server.id}
              server={server}
              connected={connected}
              busy={busy === server.id}
              onToggle={() => void run(server.id, () => (connected ? disconnect() : connect()))}
              onOpen={() => setEditing(server.id)}
            />
          );
        })}
      </ul>
      {props.servers.length === 0 ? <p className="muted">No connectors yet. Add an MCP server to give the AI its tools.</p> : null}
      {props.error ? <p className="error">{props.error}</p> : null}
      <div className="actions row">
        <Button type="button" variant="link" size="sm" onClick={() => setEditing("new")}>
          Add custom
        </Button>
      </div>
    </section>
  );
}
