// CI runs this file directly. The check is `npm run check:asar` (vvedantb-check-asar from @vvedantb/config); arguments pass through.
import { spawnSync } from "node:child_process";

const { status } = spawnSync("npm", ["run", "--silent", "check:asar", "--", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(status ?? 1);
