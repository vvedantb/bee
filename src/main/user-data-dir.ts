import { isAbsolute, resolve } from "node:path";

// An isolated user data folder for a test run of Bee (docs/linux-independent-test.md): settings, history, memory, notes, logs and
// the single-instance lock all live under it, so a test never reads or writes the user's own profile. Pure: index.ts passes
// process.argv and process.env, and calls app.setPath("userData", …) with the result before anything reads that folder.

/** The environment variable that names the folder. */
export const USER_DATA_ENV = "BEE_USER_DATA_DIR";
/** The command-line flag that names the folder: --user-data-dir=/tmp/bee-test-profile or --user-data-dir /tmp/bee-test-profile. */
export const USER_DATA_FLAG = "--user-data-dir";

const usable = (value: string | undefined): string | null => {
  const path = (value ?? "").trim();
  // A flag where the folder should be, a control character or a bare root is a mistake, not a profile.
  if (!path || path.startsWith("-") || /[\u0000-\u001f]/.test(path)) return null;
  const full = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  return full === resolve("/") ? null : full;
};

/** The folder to use instead of Electron's default, as an absolute path, or null to keep the default. The flag wins over the variable. */
export function userDataOverride(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.startsWith(`${USER_DATA_FLAG}=`)) return usable(arg.slice(USER_DATA_FLAG.length + 1));
    if (arg === USER_DATA_FLAG) return usable(argv[index + 1]);
  }
  return usable(env[USER_DATA_ENV]);
}
