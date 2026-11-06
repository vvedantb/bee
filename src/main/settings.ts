import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clampInterfaceScale, type SavedPosition } from "../core/interface-scale";
import { clampMotionPreference } from "../core/motion-preference";
import { normalizeFsRoots } from "../core/fs-sandbox";
import { mergeNames, normalizeNames } from "../core/known-names";
import { createMcpOAuthProvider, hasMcpOAuthTokens, mcpOAuthStateSchema, type McpOAuthStorage } from "../core/mcp-oauth";
import { canSubmitTranscripts } from "../core/vmem-transcript";
import type { TranscriptSettings } from "./vmem-transcript-queue";
import { isVmemConnector, mcpSlug, mcpUrlError, parseMcpArgs, parseMcpEnv, type McpServerConfig, type McpServerInfo } from "../core/mcp";
import { safeIconSrc } from "../shared/mcp-icons";
import {
  MCP_MAX_SERVERS,
  MCP_MAX_TOOLS,
  mcpServerSchema,
  type McpSave,
  type McpServer,
  type McpServerView,
  type McpSetEnabled,
  type McpTool,
  type SettingsUpdate,
  type SettingsView,
} from "../shared/ipc";

// On disk: secrets are safeStorage ciphertext (base64). Plain secrets never touch disk.
const fileSchema = z.object({
  meetingMode: z.boolean().default(false),
  // Interface size factor. Anything unlisted reads as 1 (100%).
  interfaceScale: z.unknown().optional().transform(clampInterfaceScale),
  // Animations: system, on or off. Anything else reads as on.
  motionPreference: z.unknown().optional().transform(clampMotionPreference),
  gatewayApiKey: z.string().optional(),
  // Where the overlay was last left. Main only; a bad value reads as unset.
  overlayPosition: z.object({ x: z.number().finite(), y: z.number().finite(), displayId: z.number() }).optional().catch(undefined),
  // Personalised link suggestions. The toggle is stored only once the user sets it; until then it follows whether an enabled vmem connector exists.
  personalisedLinks: z.boolean().optional(),
  // Send finished sessions to vmem (main/vmem-transcript-queue.ts). Like personalisedLinks: stored only once the user sets it;
  // until then on only while an enabled vmem connector exists. A bad value reads as unset.
  sendSessionsToVmem: z.boolean().optional().catch(undefined),
  fsRoots: z.array(z.string()).default([]),
  // Names Bee should know (core/known-names.ts): typed in Settings or learned from corrections and the screen. A bad value reads as none.
  knownNames: z.array(z.string()).default([]).catch([]),
  // Meeting context: all on until the user switches them off.
  meetingContextEnabled: z.boolean().default(true).catch(true),
  meetingCalendarEnabled: z.boolean().default(true).catch(true),
  meetingMemoryEnabled: z.boolean().default(true).catch(true),
  // Experimental: read Teams, Zoom and Google Meet windows with agent-desktop (main/meeting-window-reader.ts). Off until switched on.
  readMeetingWindowEnabled: z.boolean().default(false).catch(false),
  // Teams audio fallback (core/teams-audio.ts). Off until switched on, like readMeetingWindowEnabled: it sends the words of
  // people without Bee to speech-to-text. When on, it hears the Teams app alone, only when someone may not have Bee.
  teamsAudioFallbackEnabled: z.boolean().default(false).catch(false),
  // Mic hints in the island (renderer/src/hints.ts). On until switched off.
  hintsEnabled: z.boolean().default(true).catch(true),
  // "Bee" wake word (core/wake-word.ts): own mic phrases that start with "Bee…" go to the AI as a direct request. On until switched off.
  wakeWordEnabled: z.boolean().default(true).catch(true),
  // "Ask before sending or deleting" (core/computer-gate.ts): computer use waits for a Confirm tap before it sends, deletes, buys
  // or submits; ordinary clicks do not ask. On until switched off; a bad stored value reads as on, the safe side.
  askBeforeSendingEnabled: z.boolean().default(true).catch(true),
  // Verbose debug logs (main/debug-log.ts), on this computer only. On until switched off, for now; off keeps warnings and errors.
  verboseLogging: z.boolean().default(true).catch(true),
  // Non-secret MCP settings. A bad entry drops the list, not the whole file.
  mcpServers: z.array(mcpServerSchema).catch([]).default([]),
  // One safeStorage ciphertext (base64) for every server's secrets, as JSON keyed by server id.
  mcpSecrets: z.string().optional(),
});
// auth: bearer token or header value. env: stdio env values. oauth: tokens and client information from Connectors sign-in.
const mcpSecretsSchema = z.record(
  z.string(),
  z.object({ auth: z.string().optional(), env: z.record(z.string(), z.string()).optional(), oauth: mcpOAuthStateSchema.optional() }),
);
type McpSecrets = z.infer<typeof mcpSecretsSchema>;
type SettingsFile = z.infer<typeof fileSchema>;
type SecretName = "gatewayApiKey";

export type SettingsStore = ReturnType<typeof createSettingsStore>;

// One-time migration only: hosts of the removed vmem and Eva presets. Never used to identify a server after that.
const LEGACY_SERVER_HOSTS: ReadonlyArray<{ serverInfoName: string; hosts: readonly string[] }> = [
  { serverInfoName: "vmem", hosts: ["vmem.vedantb.com", "vmem.projectv.uk"] },
  { serverInfoName: "Eva", hosts: ["eva.vedantb.com", "dazzling-dogfish-581.eu-west-1.convex.site"] },
];

/**
 * The serverInfoName a server saved before Bee stored one gets once: from a display name that slugs to vmem or eva,
 * or from a URL on a former preset host. undefined when neither fits. Same id, so OAuth tokens and secrets stay.
 */
export function legacyServerInfoName(server: { name: string; url?: string }): string | undefined {
  const slug = mcpSlug(server.name).toLowerCase();
  if (slug === "vmem") return "vmem";
  if (slug === "eva") return "Eva";
  let host = "";
  try {
    host = new URL(server.url ?? "").hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return LEGACY_SERVER_HOSTS.find((legacy) => legacy.hosts.some((known) => host === known || host.endsWith(`.${known}`)))?.serverInfoName;
}

function storageMode(): SettingsView["secretStorage"] {
  if (!safeStorage.isEncryptionAvailable()) return "memory";
  // Linux without a keyring falls back to a hard-coded key: encrypted, but weak.
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return "weak";
  return "os";
}

export function createSettingsStore(args: {
  userDataDir: string;
  notesDir: string;
  /** The local debug log folder, shown in Settings like notesDir. */
  logsDir: string;
  envGatewayKey: string | undefined;
}) {
  const path = join(args.userDataDir, "settings.json");
  const memorySecrets = new Map<SecretName, string>();
  // MCP secrets when encryption is unavailable: kept for this session only, like the gateway key.
  let memoryMcp: McpSecrets = {};

  function read(): SettingsFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or corrupt file: start from defaults.
    }
    return {
      meetingMode: false,
      interfaceScale: 1,
      motionPreference: "on",
      fsRoots: [],
      knownNames: [],
      meetingContextEnabled: true,
      meetingCalendarEnabled: true,
      meetingMemoryEnabled: true,
      readMeetingWindowEnabled: false,
      teamsAudioFallbackEnabled: false,
      hintsEnabled: true,
      wakeWordEnabled: true,
      askBeforeSendingEnabled: true,
      verboseLogging: true,
      mcpServers: [],
    };
  }

  function write(file: SettingsFile): void {
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  // The Claude OAuth token was removed. Rewriting through the schema drops the stored key from old files.
  try {
    if ("claudeOAuthToken" in JSON.parse(readFileSync(path, "utf8"))) write(read());
  } catch {
    // Missing or corrupt file: nothing to migrate.
  }

  // Connector presets were removed. A server saved before Bee stored serverInfoName gets one once (legacyServerInfoName),
  // so a saved vmem keeps its identity. Servers keep their id, so mcpSecrets (tokens) are untouched. Runs only on a readable file.
  try {
    JSON.parse(readFileSync(path, "utf8"));
    const file = read();
    let migrated = false;
    const mcpServers = file.mcpServers.map((server) => {
      if (server.serverInfoName) return server;
      const serverInfoName = legacyServerInfoName(server);
      if (!serverInfoName) return server;
      migrated = true;
      return { ...server, serverInfoName };
    });
    if (migrated) write({ ...file, mcpServers });
  } catch {
    // Missing or corrupt file: nothing to migrate.
  }

  function getSecret(file: SettingsFile, name: SecretName): string | undefined {
    const memory = memorySecrets.get(name);
    if (memory) return memory;
    const cipher = file[name];
    if (!cipher || storageMode() === "memory") return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(cipher, "base64"));
    } catch {
      return undefined;
    }
  }

  function setSecret(file: SettingsFile, name: SecretName, value: string): SettingsFile {
    const trimmed = value.trim();
    memorySecrets.delete(name);
    if (trimmed === "") return { ...file, [name]: undefined };
    if (storageMode() === "memory") {
      memorySecrets.set(name, trimmed);
      return { ...file, [name]: undefined };
    }
    return { ...file, [name]: safeStorage.encryptString(trimmed).toString("base64") };
  }

  function readMcpSecrets(file: SettingsFile): McpSecrets {
    if (storageMode() === "memory") return memoryMcp;
    if (!file.mcpSecrets) return {};
    try {
      const parsed = mcpSecretsSchema.safeParse(JSON.parse(safeStorage.decryptString(Buffer.from(file.mcpSecrets, "base64"))));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  function writeMcpSecrets(file: SettingsFile, secrets: McpSecrets): SettingsFile {
    const kept = Object.fromEntries(Object.entries(secrets).filter(([id, secret]) => file.mcpServers.some((server) => server.id === id) && (secret.auth || secret.oauth || Object.keys(secret.env ?? {}).length > 0)));
    if (storageMode() === "memory") {
      memoryMcp = kept;
      return { ...file, mcpSecrets: undefined };
    }
    const cipher = Object.keys(kept).length === 0 ? undefined : safeStorage.encryptString(JSON.stringify(kept)).toString("base64");
    return { ...file, mcpSecrets: cipher };
  }

  function mcpView(server: McpServer, secrets: McpSecrets): McpServerView {
    return { ...server, envKeys: server.envKeys ?? [], hasAuth: Boolean(secrets[server.id]?.auth) || hasMcpOAuthTokens(secrets[server.id]?.oauth) };
  }

  function mcpList(): McpServerView[] {
    const file = read();
    const secrets = readMcpSecrets(file);
    return file.mcpServers.map((server) => mcpView(server, secrets));
  }

  /** Validates and upserts a server. Secrets: omitted = unchanged, "" = clear. */
  function mcpSave(input: McpSave): McpServerView[] {
    let file = read();
    const existing = file.mcpServers.find((server) => server.id === input.id);
    if (input.id && !existing) throw new Error("That server no longer exists");
    if (!existing && file.mcpServers.length >= MCP_MAX_SERVERS) throw new Error(`At most ${MCP_MAX_SERVERS} servers`);
    const slug = mcpSlug(input.name).toLowerCase();
    if (file.mcpServers.some((server) => server.id !== existing?.id && mcpSlug(server.name).toLowerCase() === slug)) {
      throw new Error(`Another server is already named "${input.name}"`);
    }

    const secrets = { ...readMcpSecrets(file) };
    const id = existing?.id ?? randomUUID();
    const previous = secrets[id] ?? {};
    const next: McpServer = {
      id,
      name: input.name,
      enabled: input.enabled,
      transport: input.transport,
      auth: { type: "none" },
      tools: existing?.tools,
      serverInfoName: existing?.serverInfoName,
      websiteUrl: existing?.websiteUrl,
      iconUrl: existing?.iconUrl,
      iconOverride: existing?.iconOverride,
    };
    if (input.iconOverride !== undefined) {
      if (input.iconOverride && !safeIconSrc(input.iconOverride)) throw new Error("Icon URL must start with https: or data:image");
      next.iconOverride = input.iconOverride || undefined;
    }
    let auth = previous.auth;
    let env = previous.env;
    let oauth = previous.oauth;

    if (input.transport === "http") {
      const urlError = mcpUrlError(input.url);
      if (urlError) throw new Error(urlError);
      next.url = input.url;
      const headerName = input.auth.headerName?.trim();
      if (input.auth.type === "header" && !/^[A-Za-z0-9-]+$/.test(headerName ?? "")) throw new Error("Enter a header name, for example X-API-Key");
      next.auth = input.auth.type === "header" ? { type: "header", headerName } : { type: input.auth.type };
      // A stored secret only fits the auth style it was saved for.
      if (existing && (existing.auth.type !== next.auth.type || existing.transport !== "http")) auth = undefined;
      if (input.secret !== undefined) auth = input.secret.trim() || undefined;
      if (next.auth.type === "none") auth = undefined;
      if (next.auth.type !== "none" && !auth) throw new Error("Enter a token or header value");
      env = undefined;
      // Sign-in belongs to one endpoint, and only to a server without a static token.
      if (next.auth.type !== "none" || (existing && existing.url !== next.url)) oauth = undefined;
    } else {
      if (!input.command) throw new Error("Enter a command");
      next.command = input.command;
      next.args = parseMcpArgs(input.args ?? "");
      if (input.env !== undefined) env = parseMcpEnv(input.env);
      next.envKeys = Object.keys(env ?? {});
      auth = undefined;
      oauth = undefined;
    }
    // A different endpoint or command lists different tools and may be a different server: forget the old list and what it reported.
    if (existing && (existing.url !== next.url || existing.command !== next.command || existing.transport !== next.transport)) {
      next.tools = undefined;
      next.serverInfoName = undefined;
      next.websiteUrl = undefined;
      next.iconUrl = undefined;
    }

    secrets[id] = { auth, env, oauth };
    const servers = existing ? file.mcpServers.map((server) => (server.id === id ? next : server)) : [...file.mcpServers, next];
    file = writeMcpSecrets({ ...file, mcpServers: servers }, secrets);
    write(file);
    return mcpList();
  }

  function mcpRemove(id: string): McpServerView[] {
    let file = read();
    file = writeMcpSecrets({ ...file, mcpServers: file.mcpServers.filter((server) => server.id !== id) }, readMcpSecrets(file));
    write(file);
    return mcpList();
  }

  /** Disconnect for a sign-in server: drops its tokens and switches it off, but keeps the saved server. */
  function mcpSignOut(id: string): McpServerView[] {
    const file = read();
    const secrets = readMcpSecrets(file);
    const mcpServers = file.mcpServers.map((server) => (server.id === id ? { ...server, enabled: false } : server));
    write(writeMcpSecrets({ ...file, mcpServers }, { ...secrets, [id]: { ...secrets[id], auth: undefined, oauth: undefined } }));
    return mcpList();
  }

  /** Switches a server, or one of its listed tools. */
  function mcpSetEnabled(update: McpSetEnabled): McpServerView[] {
    const file = read();
    const mcpServers = file.mcpServers.map((server) => {
      if (server.id !== update.id) return server;
      if (!update.tool) return { ...server, enabled: update.enabled };
      return { ...server, tools: server.tools?.map((item) => (item.name === update.tool ? { ...item, enabled: update.enabled } : item)) };
    });
    write({ ...file, mcpServers });
    return mcpList();
  }

  /**
   * Saves a fresh tool list. Tools seen before keep their switch; new ones start on. With serverInfo (from MCP initialize),
   * also saves the reported name, website and icon. Secrets and tokens are untouched.
   */
  function mcpRecordTools(id: string, listed: ReadonlyArray<{ name: string; description: string }>, serverInfo?: McpServerInfo): McpTool[] {
    const file = read();
    const server = file.mcpServers.find((item) => item.id === id);
    if (!server) return [];
    const known = new Map((server.tools ?? []).map((item) => [item.name, item.enabled]));
    const tools = listed.slice(0, MCP_MAX_TOOLS).map((item) => ({
      name: item.name,
      description: item.description.slice(0, 300),
      enabled: known.get(item.name) ?? true,
    }));
    const reported = serverInfo
      ? { serverInfoName: serverInfo.name, websiteUrl: serverInfo.websiteUrl, iconUrl: safeIconSrc(serverInfo.iconUrl) ?? undefined }
      : {};
    write({ ...file, mcpServers: file.mcpServers.map((item) => (item.id === id ? { ...item, tools, ...reported } : item)) });
    return tools;
  }

  /** Where one server's OAuth tokens and client information live: inside the encrypted MCP secrets. Refreshed tokens are saved through it. */
  function mcpOAuthStorage(id: string): McpOAuthStorage {
    return {
      load: () => readMcpSecrets(read())[id]?.oauth,
      save: (oauth) => {
        const file = read();
        // A server removed while signing in must not come back through a late save.
        if (!file.mcpServers.some((server) => server.id === id)) return;
        const secrets = readMcpSecrets(file);
        write(writeMcpSecrets(file, { ...secrets, [id]: { ...secrets[id], oauth } }));
      },
    };
  }

  function toConfig(server: McpServer, secrets: McpSecrets): McpServerConfig {
    const secret = secrets[server.id];
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      env: secret?.env,
      auth: server.auth,
      secret: secret?.auth,
      oauthSignedIn: hasMcpOAuthTokens(secret?.oauth),
      authProvider: server.transport === "http" ? createMcpOAuthProvider({ storage: mcpOAuthStorage(server.id) }) : undefined,
      disabledTools: server.tools?.filter((item) => !item.enabled).map((item) => item.name),
      serverInfoName: server.serverInfoName,
    };
  }

  /** An enabled sign-in server (HTTP, auth none) with no stored tokens: it can only fail with "Sign in from the Connectors tab". */
  function signedOut(server: McpServer, secrets: McpSecrets): boolean {
    return server.transport === "http" && server.auth.type === "none" && !hasMcpOAuthTokens(secrets[server.id]?.oauth);
  }

  /** Enabled servers with decrypted secrets, without signed-out ones. Read on each pipeline run, like fsRoots. Main only. */
  function mcpConfigs(): McpServerConfig[] {
    const file = read();
    const secrets = readMcpSecrets(file);
    return file.mcpServers.filter((server) => server.enabled && !signedOut(server, secrets)).map((server) => toConfig(server, secrets));
  }

  /** Names of the enabled servers mcpConfigs skips because they are not signed in. Main only. */
  function mcpSignedOut(): string[] {
    const file = read();
    const secrets = readMcpSecrets(file);
    return file.mcpServers.filter((server) => server.enabled && signedOut(server, secrets)).map((server) => server.name);
  }

  /** One server by id, enabled or not, for Test connection. Main only. */
  function mcpConfig(id: string): McpServerConfig | undefined {
    const file = read();
    const server = file.mcpServers.find((item) => item.id === id);
    return server ? toConfig(server, readMcpSecrets(file)) : undefined;
  }

  function gatewayApiKey(): string | undefined {
    return getSecret(read(), "gatewayApiKey") ?? (args.envGatewayKey?.trim() || undefined);
  }

  /** The key saved in Settings, never the env key. Only for an explicit reveal or copy. Main only. */
  function savedGatewayApiKey(): string | undefined {
    return getSecret(read(), "gatewayApiKey");
  }

  function hasVmemConnector(file: SettingsFile): boolean {
    return file.mcpServers.some((server) => server.enabled && isVmemConnector(server));
  }

  function personalisedLinks(file: SettingsFile): boolean {
    return file.personalisedLinks ?? hasVmemConnector(file);
  }

  /** What link enrichment needs: the effective toggle, and whether an enabled vmem connector can search history. Main only. */
  function linkSettings(): { enabled: boolean; hasVmem: boolean } {
    const file = read();
    return { enabled: personalisedLinks(file), hasVmem: hasVmemConnector(file) };
  }

  function sendSessionsToVmem(file: SettingsFile): boolean {
    return file.sendSessionsToVmem ?? hasVmemConnector(file);
  }

  /**
   * What the vmem transcript sender needs, read before each queue and send so Settings and Connectors changes apply at once:
   * the effective toggle, the enabled vmem connector, and whether its saved tool list has transcript_submit. Main only.
   */
  function transcriptSettings(): TranscriptSettings {
    const file = read();
    const server = file.mcpServers.find((item) => item.enabled && isVmemConnector(item));
    return {
      enabled: sendSessionsToVmem(file),
      config: server ? toConfig(server, readMcpSecrets(file)) : undefined,
      listed: server ? canSubmitTranscripts(server) : false,
    };
  }

  /** The enabled vmem connector with decrypted secrets, or undefined. Main only. */
  function vmemConfig(): McpServerConfig | undefined {
    const file = read();
    const server = file.mcpServers.find((item) => item.enabled && isVmemConnector(item));
    return server ? toConfig(server, readMcpSecrets(file)) : undefined;
  }

  function view(): SettingsView {
    const file = read();
    const saved = getSecret(file, "gatewayApiKey");
    return {
      personalisedLinks: personalisedLinks(file),
      vmemConnected: hasVmemConnector(file),
      sendSessionsToVmem: sendSessionsToVmem(file),
      gatewayKeySource: saved ? "saved" : args.envGatewayKey?.trim() ? "env" : "none",
      meetingMode: file.meetingMode,
      interfaceScale: file.interfaceScale,
      motionPreference: file.motionPreference,
      secretStorage: storageMode(),
      notesDir: args.notesDir,
      logsDir: args.logsDir,
      fsRoots: read().fsRoots,
      knownNames: normalizeNames(file.knownNames),
      meetingContextEnabled: file.meetingContextEnabled,
      meetingCalendarEnabled: file.meetingCalendarEnabled,
      meetingMemoryEnabled: file.meetingMemoryEnabled,
      readMeetingWindowEnabled: file.readMeetingWindowEnabled,
      teamsAudioFallbackEnabled: file.teamsAudioFallbackEnabled,
      hintsEnabled: file.hintsEnabled,
      wakeWordEnabled: file.wakeWordEnabled,
      askBeforeSendingEnabled: file.askBeforeSendingEnabled,
      verboseLogging: file.verboseLogging,
    };
  }

  /** The three meeting-context switches, read on each tick so Settings changes apply without a restart. Main only. */
  function meetingContext(): { enabled: boolean; calendar: boolean; memory: boolean } {
    const file = read();
    return { enabled: file.meetingContextEnabled, calendar: file.meetingCalendarEnabled, memory: file.meetingMemoryEnabled };
  }

  /** The experimental meeting window reader switch, read on each poll so Settings changes apply at once. Main only. */
  function readMeetingWindow(): boolean {
    return read().readMeetingWindowEnabled;
  }

  /** The Teams audio fallback switch, read on each status poll so Settings changes apply at once. Main only. */
  function teamsAudioFallback(): boolean {
    return read().teamsAudioFallbackEnabled;
  }

  /** The wake word switch, read on each direct request so main refuses one with it off. Main only. */
  function wakeWord(): boolean {
    return read().wakeWordEnabled;
  }

  /** "Ask before sending or deleting", read before each action computer use takes, so a change applies mid-task. Main only. */
  function askBeforeSending(): boolean {
    return read().askBeforeSendingEnabled;
  }

  /** The verbose debug log switch, for the logger at start-up. Saving it updates the logger at once (index.ts). Main only. */
  function verboseLogging(): boolean {
    return read().verboseLogging;
  }

  function save(update: SettingsUpdate): SettingsView {
    let file = read();
    if (update.gatewayApiKey !== undefined) file = setSecret(file, "gatewayApiKey", update.gatewayApiKey);
    if (update.meetingMode !== undefined) file = { ...file, meetingMode: update.meetingMode };
    if (update.interfaceScale !== undefined) file = { ...file, interfaceScale: clampInterfaceScale(update.interfaceScale) };
    if (update.motionPreference !== undefined) file = { ...file, motionPreference: clampMotionPreference(update.motionPreference) };
    if (update.personalisedLinks !== undefined) file = { ...file, personalisedLinks: update.personalisedLinks };
    if (update.sendSessionsToVmem !== undefined) file = { ...file, sendSessionsToVmem: update.sendSessionsToVmem };
    if (update.meetingContextEnabled !== undefined) file = { ...file, meetingContextEnabled: update.meetingContextEnabled };
    if (update.meetingCalendarEnabled !== undefined) file = { ...file, meetingCalendarEnabled: update.meetingCalendarEnabled };
    if (update.meetingMemoryEnabled !== undefined) file = { ...file, meetingMemoryEnabled: update.meetingMemoryEnabled };
    if (update.readMeetingWindowEnabled !== undefined) file = { ...file, readMeetingWindowEnabled: update.readMeetingWindowEnabled };
    if (update.teamsAudioFallbackEnabled !== undefined) file = { ...file, teamsAudioFallbackEnabled: update.teamsAudioFallbackEnabled };
    if (update.hintsEnabled !== undefined) file = { ...file, hintsEnabled: update.hintsEnabled };
    if (update.wakeWordEnabled !== undefined) file = { ...file, wakeWordEnabled: update.wakeWordEnabled };
    if (update.askBeforeSendingEnabled !== undefined) file = { ...file, askBeforeSendingEnabled: update.askBeforeSendingEnabled };
    if (update.verboseLogging !== undefined) file = { ...file, verboseLogging: update.verboseLogging };
    if (update.fsRoots !== undefined) {
      const { roots, invalid } = normalizeFsRoots(update.fsRoots);
      if (invalid.length > 0) throw new Error(`Folders must be absolute paths: ${invalid.join(", ")}`);
      file = { ...file, fsRoots: roots };
    }
    if (update.knownNames !== undefined) file = { ...file, knownNames: normalizeNames(update.knownNames) };
    write(file);
    return view();
  }

  // Read on each direct request, so a name typed in Settings or learned a moment ago is used at once.
  function knownNames(): string[] {
    return normalizeNames(read().knownNames);
  }

  /** Adds names Bee learned (a spelling correction, a chat name on screen). Main only; the list stays editable in Settings. */
  function learnNames(names: readonly string[]): void {
    if (names.length === 0) return;
    const file = read();
    const merged = mergeNames(file.knownNames, names);
    if (JSON.stringify(merged) === JSON.stringify(file.knownNames)) return;
    write({ ...file, knownNames: merged });
  }

  // Read on each pipeline run, so Settings changes apply without a restart.
  function fsRoots(): string[] {
    return normalizeFsRoots(read().fsRoots).roots;
  }

  function overlayPosition(): SavedPosition | undefined {
    return read().overlayPosition;
  }

  function saveOverlayPosition(position: SavedPosition): void {
    write({ ...read(), overlayPosition: position });
  }

  return { view, save, meetingContext, readMeetingWindow, teamsAudioFallback, wakeWord, askBeforeSending, verboseLogging, overlayPosition, saveOverlayPosition, gatewayApiKey, savedGatewayApiKey, linkSettings, vmemConfig, transcriptSettings, fsRoots, knownNames, learnNames, mcpList, mcpSave, mcpRemove, mcpSignOut, mcpSetEnabled, mcpRecordTools, mcpConfigs, mcpSignedOut, mcpConfig, mcpOAuthStorage };
}
