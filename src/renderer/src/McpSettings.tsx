import { useState, type FormEvent } from "react";
import type { McpSave, McpServerView } from "../../shared/ipc";
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
            <input name="url" defaultValue={server?.url} placeholder="https://vmem.vedantb.com/mcp" required spellCheck={false} />
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

function McpServerRow({ server, test, onEdit }: { server: McpServerView; test: McpTestState | undefined; onEdit: () => void }) {
  const status = test ? testLabel(test) : null;
  return (
    <li className="mcp-server">
      <div className="row">
        <strong>{server.name}</strong>
        <span className="muted">{server.transport === "http" ? "Streamable HTTP" : "stdio"}</span>
        <label className="toggle spacer">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(event) => void actions.setMcpEnabled({ id: server.id, enabled: event.currentTarget.checked })}
          />
          Enabled
        </label>
      </div>
      <div className="row">
        <button type="button" disabled={test?.busy} onClick={() => void actions.testMcpServer(server.id)}>
          Test connection
        </button>
        <button type="button" className="link" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="link" onClick={() => void actions.removeMcpServer(server.id)}>
          Remove
        </button>
      </div>
      {status ? <p className={status.failed ? "error" : "muted"}>{status.text}</p> : null}
      <McpToolList server={server} />
    </li>
  );
}

/** Settings → MCP servers. Live data and actions go through window.bee (store.ts); secrets never come back. */
export function McpSettings(props: { servers: McpServerView[]; tests: Record<string, McpTestState>; error: string | null }) {
  // "new", a server id, or null (list only).
  const [editing, setEditing] = useState<string | null>(null);
  const editingServer = props.servers.find((server) => server.id === editing) ?? null;
  const form = editing ? (
    // Remount per target so each form starts from its own saved values.
    <McpForm key={editing} server={editingServer} error={props.error} onDone={() => setEditing(null)} />
  ) : null;

  return (
    <section>
      <h2>MCP servers</h2>
      {props.servers.length === 0 && !editing ? (
        <p className="muted">Luna can use tools from MCP servers, such as vmem, Eva or a local command. Add one to try it.</p>
      ) : null}
      {props.servers.length > 0 ? (
        <ul className="mcp-list">
          {props.servers.map((server) => (
            <McpServerRow key={server.id} server={server} test={props.tests[server.id]} onEdit={() => setEditing(server.id)} />
          ))}
        </ul>
      ) : null}
      {!editing && props.error ? <p className="error">{props.error}</p> : null}
      {form ?? (
        <div className="actions row">
          <button type="button" onClick={() => setEditing("new")}>
            Add server
          </button>
        </div>
      )}
    </section>
  );
}
