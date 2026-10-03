import { useUser } from "@clerk/electron/react";
import {
  IconCopy,
  IconLogout,
  IconMicrophone,
  IconMicrophoneOff,
  IconUserPlus,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { namesLabel } from "../../core/room-picker";
import type { TeamsView } from "../../shared/ipc";
import { actions, syncCard, type BeeState } from "./store";

// Teams mode UI: the popup under the notch, the sync status on Live and the Team section in Settings.

const ICON = { size: 16, stroke: 1.75 };

type RoomOption = NonNullable<TeamsView["prompt"]>["others"][number];

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

function started(option: RoomOption): string {
  if (option.reason === "invited" && option.invitedBy) return `${option.invitedBy} invited you · ${option.code}`;
  const age = option.ageMinutes < 1 ? "just now" : `${option.ageMinutes} min ago`;
  return `started ${age} · ${option.code}`;
}

/** Names of the others in my sync: "Alice, Bob". */
export function syncedWith(teams: TeamsView): string {
  const room = teams.room;
  if (!room) return "";
  const others = room.members.filter((member) => member.userId !== teams.me?.userId).map((member) => member.displayName);
  return others.length > 0 ? `Synced with ${namesLabel(others, 3)}` : "Waiting for teammates to join";
}

function JoinByCode({ busy }: { busy: boolean }) {
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const code = formString(event.currentTarget, "code");
    if (code) void actions.teams({ type: "joinSyncByCode", code });
  }
  return (
    <form className="simulate" onSubmit={onSubmit}>
      <input name="code" placeholder="Sync code, e.g. amber-otter" autoComplete="off" autoFocus />
      <button type="submit" disabled={busy}>
        Join
      </button>
    </form>
  );
}

function PromptHead({ title }: { title: string }) {
  return (
    <div className="sync-head">
      <IconUsersGroup {...ICON} />
      <strong>{title}</strong>
      <button type="button" className="icon-button" title="Not now" onClick={() => void actions.teams({ type: "dismissPrompt" })}>
        <IconX {...ICON} />
      </button>
    </div>
  );
}

// Two or more Teams windows look like calls: the user says which one they are in before any sync is offered.
function MeetingPick({ prompt, busy }: { prompt: NonNullable<TeamsView["prompt"]>; busy: boolean }) {
  return (
    <>
      <PromptHead title="Which meeting?" />
      <p className="muted">More than one Teams window looks like a call. Pick the one you are in.</p>
      <ul className="sync-list sync-picks">
        {prompt.meetings.map((meeting) => (
          <li key={meeting.key}>
            <button type="button" className="primary sync-main" disabled={busy} onClick={() => void actions.teams({ type: "selectMeeting", key: meeting.key })}>
              <span>{meeting.label}</span>
              {meeting.title !== meeting.label ? <span className="sync-sub">{meeting.title}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// Two or more syncs match equally well: list them all, with no default. Nothing joins without a click.
function RoomPick({ prompt, busy }: { prompt: NonNullable<TeamsView["prompt"]>; busy: boolean }) {
  const [code, setCode] = useState(false);
  return (
    <>
      <PromptHead title="Teams meeting detected" />
      <p className="muted">More than one sync is live. Pick the room for your call.</p>
      <ul className="sync-list sync-picks">
        {prompt.others.map((option) => (
          <li key={option.roomId}>
            <button type="button" className="sync-main" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: option.roomId })}>
              <span>Join “{option.label}”</span>
              <span className="sync-sub">{started(option)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void actions.teams({ type: "startSync", invite: [] })}>
          Start new sync
        </button>
        <button type="button" className="link" onClick={() => setCode(!code)}>
          Join by code
        </button>
      </div>
      {code ? <JoinByCode busy={busy} /> : null}
    </>
  );
}

// Notion-style: one main choice, one alternative, the rest behind links. Nothing joins without a click.
function SyncPrompt({ prompt, busy }: { prompt: NonNullable<TeamsView["prompt"]>; busy: boolean }) {
  const [more, setMore] = useState<"others" | "code" | null>(null);
  const primary = prompt.primary;
  if (prompt.meetings.length > 1 && !prompt.selectedMeetingKey) return <MeetingPick prompt={prompt} busy={busy} />;
  if (prompt.ambiguous && !primary) return <RoomPick prompt={prompt} busy={busy} />;
  return (
    <>
      <PromptHead title="Teams meeting detected" />
      <p className="muted">Sync notes with teammates in this call? Only Bee members who join are captured.</p>
      {primary ? (
        <button type="button" className="primary sync-main" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: primary.roomId })}>
          <span>Join “{primary.label}”</span>
          <span className="sync-sub">{started(primary)}</span>
        </button>
      ) : null}
      <button type="button" className={primary ? "" : "primary"} disabled={busy} onClick={() => void actions.teams({ type: "startSync", invite: [] })}>
        {primary ? "Start new sync" : "Start meeting sync"}
      </button>
      <div className="row">
        {prompt.others.length > 0 ? (
          <button type="button" className="link" onClick={() => setMore(more === "others" ? null : "others")}>
            Other syncs ({prompt.others.length})
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => setMore(more === "code" ? null : "code")}>
          Join by code
        </button>
      </div>
      {more === "others" ? (
        <ul className="sync-list">
          {prompt.others.map((option) => (
            <li key={option.roomId}>
              <button type="button" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: option.roomId })}>
                Join “{option.label}”
              </button>
              <span className="muted">{started(option)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {more === "code" ? <JoinByCode busy={busy} /> : null}
    </>
  );
}

// After starting: optional one-tap invites for teammates in a meeting now. Nobody is pre-ticked.
function InviteStep({ teams, busy }: { teams: TeamsView; busy: boolean }) {
  const room = teams.room;
  if (!room) return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const userIds = new FormData(event.currentTarget).getAll("invite").filter((value) => typeof value === "string");
    if (userIds.length === 0) return;
    if (await actions.teams({ type: "invite", userIds })) actions.setInviteOpen(false);
  }

  return (
    <>
      <div className="sync-head">
        <IconUsersGroup {...ICON} />
        <strong>Sync started</strong>
        <code>{room.code}</code>
      </div>
      <p className="muted">Invite who is here, or paste the code in the Teams chat.</p>
      <form className="settings" onSubmit={(event) => void onSubmit(event)}>
        {teams.roster.length > 0 ? (
          <ul className="roster">
            {teams.roster.map((member) => (
              <li key={member.userId}>
                <label className="toggle">
                  <input type="checkbox" name="invite" value={member.userId} /> {member.displayName}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No other teammates are in a meeting right now.</p>
        )}
        <div className="row">
          {teams.roster.length > 0 ? (
            <button type="submit" className="primary" disabled={busy}>
              <IconUserPlus {...ICON} /> Invite
            </button>
          ) : null}
          <button type="button" onClick={() => actions.setInviteOpen(false)}>
            Done
          </button>
        </div>
      </form>
    </>
  );
}

function MergeOffer({ merge, busy }: { merge: NonNullable<TeamsView["merge"]>; busy: boolean }) {
  return (
    <>
      <div className="sync-head">
        <IconUsersGroup {...ICON} />
        <strong>{merge.label}</strong>
      </div>
      <p className="muted">
        {merge.waiting ? "Waiting for them to tap Merge too." : "You both started a sync at the same time. Merging needs a tap from both of you."}
      </p>
      <div className="row">
        {merge.waiting ? null : (
          <button type="button" className="primary" disabled={busy} onClick={() => void actions.teams({ type: "merge", accept: true })}>
            Merge
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void actions.teams({ type: "merge", accept: false })}>
          Keep separate
        </button>
      </div>
    </>
  );
}

/** The card under the notch. */
export function SyncCard({ state }: { state: BeeState }) {
  const card = syncCard(state);
  const teams = state.teams;
  if (!card || !teams) return null;
  return (
    <section className="sync-card">
      {card === "prompt" && teams.prompt ? <SyncPrompt key={teams.prompt.epoch} prompt={teams.prompt} busy={state.teamsBusy} /> : null}
      {card === "invite" ? <InviteStep teams={teams} busy={state.teamsBusy} /> : null}
      {card === "merge" && teams.merge ? <MergeOffer merge={teams.merge} busy={state.teamsBusy} /> : null}
      {state.teamsError ? <p className="error">{state.teamsError}</p> : null}
    </section>
  );
}

/** Live tab: sync status chip, pause sharing and leave. Hidden when Teams mode is off or there is no team. */
export function SyncSection({ state }: { state: BeeState }) {
  const teams = state.teams;
  if (!teams?.relayConfigured || !teams.team) return null;
  const room = teams.room;
  return (
    <section>
      <h2>Teams sync</h2>
      {room ? (
        <>
          <div className="row">
            <span className="chip">
              <IconUsersGroup {...ICON} /> {syncedWith(teams)}
            </span>
            <code>{room.code}</code>
          </div>
          <div className="row actions">
            <button type="button" onClick={() => void actions.teams({ type: "setShareMuted", muted: !teams.shareMuted })}>
              {teams.shareMuted ? <IconMicrophone {...ICON} /> : <IconMicrophoneOff {...ICON} />}
              {teams.shareMuted ? "Resume sharing" : "Pause sharing"}
            </button>
            <button type="button" disabled={state.teamsBusy} onClick={() => void actions.teams({ type: "leaveSync" })}>
              <IconLogout {...ICON} /> Leave sync
            </button>
            <button type="button" className="link" onClick={() => actions.setInviteOpen(true)}>
              Invite
            </button>
          </div>
          <p className="muted">
            {teams.shareMuted
              ? "Sharing paused: what you say stays on this device."
              : state.mic.on
                ? "Sharing your mic phrases with this sync."
                : "Turn on the mic to share what you say. Typed lines stay on this device."}
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            {teams.detection.inMeeting ? "Teams meeting detected." : "Bee offers a sync when desktop Teams is in a meeting."}
          </p>
          <div className="row actions">
            <button type="button" disabled={state.teamsBusy} onClick={() => void actions.teams({ type: "startSync", invite: [] })}>
              <IconUsersGroup {...ICON} /> Start meeting sync
            </button>
          </div>
        </>
      )}
      {teams.notice ? <p className="muted">{teams.notice}</p> : null}
      {teams.relayError ? <p className="error">{teams.relayError}</p> : null}
      {state.teamsError && !syncCard(state) ? <p className="error">{state.teamsError}</p> : null}
    </section>
  );
}

function TeamJoin({ teams, busy }: { teams: TeamsView; busy: boolean }) {
  const { user } = useUser();
  const defaultName = user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress.split("@")[0] || "";

  function join(form: HTMLFormElement): void {
    const code = formString(form, "code");
    const displayName = formString(form, "displayName");
    if (code && displayName) void actions.teams({ type: "joinTeam", code, displayName });
  }

  function create(form: HTMLFormElement | null): void {
    if (!form) return;
    const name = formString(form, "teamName");
    const displayName = formString(form, "displayName");
    if (name && displayName) void actions.teams({ type: "createTeam", name, displayName });
  }

  return (
    <form
      className="settings"
      onSubmit={(event) => {
        event.preventDefault();
        join(event.currentTarget);
      }}
    >
      <label>
        Your name
        <input name="displayName" defaultValue={defaultName} placeholder="Shown to teammates" autoComplete="off" />
      </label>
      <label>
        Join a team
        <span className="row">
          <input key={teams.pendingInvite} name="code" defaultValue={teams.pendingInvite ?? ""} placeholder="Invite code or bee://team/ link" autoComplete="off" />
          <button type="submit" disabled={busy}>
            Join team
          </button>
        </span>
        {teams.pendingInvite ? <span className="muted">Invite link received. Check the name, then Join team.</span> : null}
      </label>
      <label>
        Or create one
        <span className="row">
          <input name="teamName" placeholder="Company or team name" autoComplete="off" />
          <button type="button" disabled={busy} onClick={(event) => create(event.currentTarget.form)}>
            Create team
          </button>
        </span>
      </label>
    </form>
  );
}

function TeamDetails({ teams, busy }: { teams: TeamsView; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const team = teams.team;
  if (!team) return null;

  async function copy(): Promise<void> {
    setCopied(await actions.teams({ type: "copyInvite" }));
  }

  return (
    <div className="settings">
      <p>
        <strong>{team.name}</strong> <span className="muted">· {team.members.length} {team.members.length === 1 ? "member" : "members"}</span>
      </p>
      <label>
        Invite link
        <span className="row">
          <input type="text" readOnly value={team.inviteLink} aria-label="Invite link" />
          <button type="button" onClick={() => void copy()}>
            <IconCopy {...ICON} /> {copied ? "Copied" : "Copy"}
          </button>
        </span>
        <span className="muted">Code {team.inviteCode}. Anyone with it can join, so share it only inside your company.</span>
      </label>
      <ul className="members">
        {team.members.map((member) => (
          <li key={member.userId}>
            {member.displayName}
            {member.userId === teams.me?.userId ? <span className="muted"> (you)</span> : null}
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="link" disabled={busy} onClick={() => void actions.teams({ type: "leaveTeam" })}>
          Leave team
        </button>
      </div>
    </div>
  );
}

/** Settings: create or join the company team, share its invite, list members, leave. */
export function TeamSection({ state }: { state: BeeState }) {
  const teams = state.teams;
  return (
    <section>
      <h2>Team</h2>
      {!teams ? (
        <p className="muted">Loading…</p>
      ) : !teams.relayConfigured ? (
        <p className="muted">Teams mode is off. Set BEE_RELAY_URL to your Bee relay to turn it on.</p>
      ) : teams.team ? (
        <TeamDetails teams={teams} busy={state.teamsBusy} />
      ) : (
        <TeamJoin teams={teams} busy={state.teamsBusy} />
      )}
      {teams?.relayError ? <p className="error">{teams.relayError}</p> : null}
      {state.teamsError ? <p className="error">{state.teamsError}</p> : null}
      <p className="muted">
        Teammates on your team see when you are in a meeting. Bee never joins the call and only shares your own mic
        phrases, after you join a sync.
      </p>
    </section>
  );
}
