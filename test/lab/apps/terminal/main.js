// Lab terminal (dev only): a window that shows LAB_TERMINAL_TEXT, for "send George the error in my terminal". Its process is named
// gnome-terminal (test/lab/setup.sh), so agent-desktop lists it as a terminal.
const { app, BrowserWindow } = require("electron");

app.setName("Terminal");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 500, x: 120, y: 160, title: "Terminal" });
  const text = process.env.LAB_TERMINAL_TEXT ?? "";
  const html = `<!doctype html><meta charset="utf-8"><title>${process.env.LAB_TERMINAL_TITLE ?? "Terminal"}</title><body style="margin:0;background:#1e1e1e;color:#ddd"><pre role="log" aria-label="Terminal output" style="padding:12px;font:13px monospace;white-space:pre-wrap">${text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
