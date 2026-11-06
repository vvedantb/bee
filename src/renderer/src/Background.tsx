import { IconLoader2, IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import type { BackgroundJobView } from "../../shared/ipc";
import { activityLabel } from "./island";

// Background tasks (core/background.ts): the notch chip while any run, and the Live tab's list with a Stop for each. No store here,
// so the screenshots (test/e2e/background-shots.ts) render the same markup.

const ICON = { size: 16, stroke: 1.75 };

const running = (jobs: readonly BackgroundJobView[]) => jobs.filter((job) => job.status === "running");

/** The notch chip: how many tasks run, like the Teams sync chip. Opens the Live tab. Nothing when none run. */
export function BackgroundChip(props: { jobs: readonly BackgroundJobView[]; onOpen: () => void }) {
  const count = running(props.jobs).length;
  if (count === 0) return null;
  const title = count === 1 ? `1 background task running: ${running(props.jobs)[0]?.title ?? ""}` : `${count} background tasks running`;
  return (
    <Button type="button" variant="ghost" size="sm" className="sync-chip rounded-full" title={title} onClick={props.onOpen}>
      <IconLoader2 {...ICON} className="spin" />
      {count}
    </Button>
  );
}

function statusLine(job: BackgroundJobView): string {
  if (job.status === "running") return job.tool ? activityLabel(job.tool) : "Working…";
  if (job.status === "stopped") return "Stopped.";
  if (job.status === "failed") return job.result?.guideError ?? "Failed.";
  return job.result?.tips[0] ?? "Done.";
}

/** Live tab: each task with what it is doing or how it ended, and Stop while it runs. Hidden when there are none. */
export function BackgroundSection(props: { jobs: readonly BackgroundJobView[]; onStop: (id: string) => void }) {
  if (props.jobs.length === 0) return null;
  return (
    <section>
      <h2>Background tasks</h2>
      <ul className="flex flex-col gap-2">
        {[...props.jobs].reverse().map((job) => (
          <li key={job.id} className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{job.title}</span>
              <span className={job.status === "failed" ? "error truncate" : "muted truncate"}>{statusLine(job)}</span>
            </div>
            {job.status === "running" ? (
              <Button type="button" variant="secondary" size="sm" title={`Stop ${job.title}`} onClick={() => props.onStop(job.id)}>
                <IconPlayerStop {...ICON} /> Stop
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
