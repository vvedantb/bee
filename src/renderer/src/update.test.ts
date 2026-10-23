import { describe, expect, it, vi } from "vitest";
import type { UpdateAction } from "../../shared/ipc";
import type { UpdateState } from "./store";
import { updateButton, updateNow, type UpdateIpc } from "./update";

const CHECK = { currentVersion: "0.3.14", latestVersion: "0.3.15", available: true, releaseUrl: "https://example.com/release", error: null };
const OK: UpdateAction = { error: null };

/** A fake window.bee and a state setter that records each patch, as store.ts setUpdate merges them. */
function harness(download: UpdateAction | Error = OK, install: UpdateAction = OK) {
  let update: UpdateState = { status: "idle", check: CHECK, error: null };
  const calls: string[] = [];
  const ipc: UpdateIpc = {
    downloadUpdate: vi.fn(async () => {
      calls.push(`download:${update.status}`);
      if (download instanceof Error) throw download;
      return download;
    }),
    installUpdate: vi.fn(async () => {
      calls.push(`install:${update.status}`);
      return install;
    }),
  };
  const setUpdate = (patch: Partial<UpdateState>) => {
    update = { ...update, ...patch };
  };
  return { ipc, setUpdate, calls, state: () => update, setState: (next: Partial<UpdateState>) => setUpdate(next) };
}

describe("updateNow (the notch update button)", () => {
  it("downloads, shows downloading meanwhile, then quits and installs", async () => {
    const run = harness();
    await updateNow(run.state().status, run.ipc, run.setUpdate);
    expect(run.calls).toEqual(["download:downloading", "install:ready"]);
    expect(run.state()).toMatchObject({ status: "ready", error: null });
  });

  it("installs straight away when the update is already downloaded", async () => {
    const run = harness();
    run.setState({ status: "ready" });
    await updateNow("ready", run.ipc, run.setUpdate);
    expect(run.calls).toEqual(["install:ready"]);
  });

  it("does not install after a failed download, and shows the error", async () => {
    const run = harness({ error: "Download failed: HTTP 404" });
    await updateNow("idle", run.ipc, run.setUpdate);
    expect(run.ipc.installUpdate).not.toHaveBeenCalled();
    expect(run.state()).toMatchObject({ status: "idle", error: "Download failed: HTTP 404" });
    expect(updateButton(run.state())).toEqual({ busy: false, failed: true, title: "Download failed: HTTP 404 Click to try again." });
  });

  it("turns a thrown IPC error into the error state", async () => {
    const run = harness(new Error("IPC closed"));
    await updateNow("idle", run.ipc, run.setUpdate);
    expect(run.state()).toMatchObject({ status: "idle", error: "IPC closed" });
  });

  it("shows an install error", async () => {
    const run = harness(OK, { error: "Could not open the installer: denied" });
    await updateNow("idle", run.ipc, run.setUpdate);
    expect(run.state().error).toBe("Could not open the installer: denied");
  });

  it("ignores clicks while a check or download is running", async () => {
    const run = harness();
    await updateNow("downloading", run.ipc, run.setUpdate);
    await updateNow("checking", run.ipc, run.setUpdate);
    expect(run.calls).toEqual([]);
  });
});

describe("updateButton", () => {
  const update = (patch: Partial<UpdateState>): UpdateState => ({ status: "idle", check: CHECK, error: null, ...patch });

  it("says what a click does, and is busy while downloading", () => {
    expect(updateButton(update({}))).toEqual({ busy: false, failed: false, title: "Bee 0.3.15 is available. Click to download and restart." });
    expect(updateButton(update({ status: "downloading" }))).toEqual({ busy: true, failed: false, title: "Downloading Bee 0.3.15…" });
    expect(updateButton(update({ status: "ready" }))).toEqual({ busy: false, failed: false, title: "Restart to install Bee 0.3.15" });
  });
});
