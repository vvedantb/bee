// Where a command-line tool the user installed may be: Claude Code (core/claude-code.ts) and OpenCode Browse (core/browse.ts). Pure:
// main checks each path in turn (main/binary.ts executable).

export type FindArgs = { platform: NodeJS.Platform; home: string; env: Readonly<Record<string, string | undefined>> };

/**
 * Candidate paths in order: the `override` env var, then each PATH folder, then the folders the tool's installers use (`installDirs`,
 * given the platform's path join). An app started from Finder or the Start menu does not get the shell's PATH, so the install folders
 * are checked by name. `name` gets ".exe" on Windows: only native binaries, since a .cmd shim cannot start without a shell.
 */
export function binaryCandidates(args: FindArgs & { name: string; override: string; installDirs: (windows: boolean, join: (...parts: string[]) => string) => string[] }): string[] {
  const windows = args.platform === "win32";
  const sep = windows ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(sep);
  const name = windows ? `${args.name}.exe` : args.name;
  const pathDirs = (args.env.PATH ?? args.env.Path ?? "").split(windows ? ";" : ":").filter(Boolean);
  const override = args.env[args.override]?.trim();
  return [...new Set([...(override ? [override] : []), ...[...pathDirs, ...args.installDirs(windows, join)].map((dir) => join(dir.replace(/[\\/]+$/, ""), name))])];
}
