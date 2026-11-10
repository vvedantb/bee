// Lab Teams (dev only, never shipped): a Microsoft Teams look-alike for scenario tests (test/scenarios.lab.test.ts). Its process
// is named ms-teams (test/lab/setup.sh copies Electron under that name), so agent-desktop finds it as Teams. The chats come from
// LAB_TEAMS (JSON); what happens (chat opened, message sent) is appended to LAB_EVENTS as JSON lines.
const { app, BrowserWindow } = require("electron");
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

app.setName("Microsoft Teams");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 760, title: "Microsoft Teams", webPreferences: { contextIsolation: false, nodeIntegration: false } });
  win.webContents.on("console-message", ({ message }) => {
    if (message.startsWith("LAB_EVENT ") && process.env.LAB_EVENTS) appendFileSync(process.env.LAB_EVENTS, `${message.slice("LAB_EVENT ".length)}\n`);
  });
  const data = readFileSync(process.env.LAB_TEAMS, "utf8");
  win.loadFile(join(__dirname, "index.html"), { hash: encodeURIComponent(data) });
});
