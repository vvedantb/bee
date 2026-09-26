import { safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SettingsUpdate, SettingsView } from "../shared/ipc";

// On disk: secrets are safeStorage ciphertext (base64). Plain secrets never touch disk.
const fileSchema = z.object({
  meetingMode: z.boolean().default(false),
  gatewayApiKey: z.string().optional(),
  claudeOAuthToken: z.string().optional(),
});
type SettingsFile = z.infer<typeof fileSchema>;
type SecretName = "gatewayApiKey" | "claudeOAuthToken";

export type SettingsStore = ReturnType<typeof createSettingsStore>;

function storageMode(): SettingsView["secretStorage"] {
  if (!safeStorage.isEncryptionAvailable()) return "memory";
  // Linux without a keyring falls back to a hard-coded key: encrypted, but weak.
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return "weak";
  return "os";
}

export function createSettingsStore(args: { userDataDir: string; notesDir: string; envGatewayKey: string | undefined }) {
  const path = join(args.userDataDir, "settings.json");
  const memorySecrets = new Map<SecretName, string>();

  function read(): SettingsFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or corrupt file: start from defaults.
    }
    return { meetingMode: false };
  }

  function write(file: SettingsFile): void {
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
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

  function gatewayApiKey(): string | undefined {
    return getSecret(read(), "gatewayApiKey") ?? (args.envGatewayKey?.trim() || undefined);
  }

  function view(): SettingsView {
    const file = read();
    const saved = getSecret(file, "gatewayApiKey");
    return {
      gatewayKeySource: saved ? "saved" : args.envGatewayKey?.trim() ? "env" : "none",
      hasClaudeToken: Boolean(getSecret(file, "claudeOAuthToken")),
      meetingMode: file.meetingMode,
      secretStorage: storageMode(),
      notesDir: args.notesDir,
    };
  }

  function save(update: SettingsUpdate): SettingsView {
    let file = read();
    if (update.gatewayApiKey !== undefined) file = setSecret(file, "gatewayApiKey", update.gatewayApiKey);
    // Reserved for a later version: stored securely, never used at runtime in v1.
    if (update.claudeOAuthToken !== undefined) file = setSecret(file, "claudeOAuthToken", update.claudeOAuthToken);
    if (update.meetingMode !== undefined) file = { ...file, meetingMode: update.meetingMode };
    write(file);
    return view();
  }

  return { view, save, gatewayApiKey };
}
