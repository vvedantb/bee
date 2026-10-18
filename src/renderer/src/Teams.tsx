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
import { Badge, Button, Checkbox, Input } from "@vvedantb/ui";
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
      <Input className="h-9" name="code" placeholder="Sync code, e.g. amber-otter" autoComplete="off" autoFocus />
      <Button type="submit" disabled={busy} variant="secondary" size="sm">
        Join
      </Button>
    </form>
  );
}

function PromptHead({ title }: { title: string }) {
  return (
    <div className="sync-head">
      <IconUsersGroup {...ICON} />
      <strong>{title}</strong>
      <Button type="button" title="Not now" onClick={() => void actions.teams({ type: "dismissPrompt" })} variant="ghost" size="icon-sm">
        <IconX {...ICON} />
      </Button>
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
            <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "selectMeeting", key: meeting.key })} size="sm" className="sync-main h-auto">
              <span>{meeting.label}</span>
              {meeting.title !== meeting.label ? <span className="sync-sub">{meeting.title}</span> : null}
            </Button>
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
            <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: option.roomId })} variant="secondary" size="sm" className="sync-main h-auto">
              <span>Join “{option.label}”</span>
              <span className="sync-sub">{started(option)}</span>
            </Button>
          </li>
        ))}
      </ul>
      <div className="row">
        <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "startSync", invite: [] })} variant="secondary" size="sm">
          Start new sync
        </Button>
        <Button type="button" onClick={() => setCode(!code)} variant="link" size="sm">
          Join by code
        </Button>
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
        <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: primary.roomId })} size="sm" className="sync-main h-auto">
          <span>Join “{primary.label}”</span>
          <span className="sync-sub">{started(primary)}</span>
        </Button>
      ) : null}
      <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "startSync", invite: [] })} variant={primary ? "secondary" : "default"} size="sm">
        {primary ? "Start new sync" : "Start meeting sync"}
      </Button>
      <div className="row">
        {prompt.others.length > 0 ? (
          <Button type="button" onClick={() => setMore(more === "others" ? null : "others")} variant="link" size="sm">
            Other syncs ({prompt.others.length})
          </Button>
        ) : null}
        <Button type="button" onClick={() => setMore(more === "code" ? null : "code")} variant="link" size="sm">
          Join by code
        </Button>
      </div>
      {more === "others" ? (
        <ul className="sync-list">
          {prompt.others.map((option) => (
            <li key={option.roomId}>
              <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "joinSync", roomId: option.roomId })} variant="secondary" size="sm">
                Join “{option.label}”
              </Button>
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
                <label>
                  <Checkbox name="invite" value={member.userId} /> {member.displayName}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No other teammates are in a meeting right now.</p>
        )}
        <div className="row">
          {teams.roster.length > 0 ? (
            <Button type="submit" disabled={busy} size="sm">
              <IconUserPlus {...ICON} /> Invite
            </Button>
          ) : null}
          <Button type="button" onClick={() => actions.setInviteOpen(false)} variant="secondary" size="sm">
            Done
          </Button>
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
          <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "merge", accept: true })} size="sm">
            Merge
          </Button>
        )}
        <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "merge", accept: false })} variant="secondary" size="sm">
          Keep separate
        </Button>
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
            <Badge variant="secondary">
              <IconUsersGroup {...ICON} /> {syncedWith(teams)}
            </Badge>
            <code>{room.code}</code>
          </div>
          <div className="row actions">
            <Button type="button" onClick={() => void actions.teams({ type: "setShareMuted", muted: !teams.shareMuted })} variant="secondary" size="sm">
              {teams.shareMuted ? <IconMicrophone {...ICON} /> : <IconMicrophoneOff {...ICON} />}
              {teams.shareMuted ? "Resume sharing" : "Pause sharing"}
            </Button>
            <Button type="button" disabled={state.teamsBusy} onClick={() => void actions.teams({ type: "leaveSync" })} variant="secondary" size="sm">
              <IconLogout {...ICON} /> Leave sync
            </Button>
            <Button type="button" onClick={() => actions.setInviteOpen(true)} variant="link" size="sm">
              Invite
            </Button>
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
            <Button type="button" disabled={state.teamsBusy} onClick={() => void actions.teams({ type: "startSync", invite: [] })} variant="secondary" size="sm">
              <IconUsersGroup {...ICON} /> Start meeting sync
            </Button>
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
        <Input className="h-9" name="displayName" defaultValue={defaultName} placeholder="Shown to teammates" autoComplete="off" />
      </label>
      <label>
        Join a team
        <span className="row">
          <Input className="h-9" key={teams.pendingInvite} name="code" defaultValue={teams.pendingInvite ?? ""} placeholder="Invite code or bee://team/ link" autoComplete="off" />
          <Button type="submit" disabled={busy} variant="secondary" size="sm">
            Join team
          </Button>
        </span>
        {teams.pendingInvite ? <span className="muted">Invite link received. Check the name, then Join team.</span> : null}
      </label>
      <label>
        Or create one
        <span className="row">
          <Input className="h-9" name="teamName" placeholder="Company or team name" autoComplete="off" />
          <Button type="button" disabled={busy} onClick={(event) => create(event.currentTarget.form)} variant="secondary" size="sm">
            Create team
          </Button>
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
          <Input className="h-9" type="text" readOnly value={team.inviteLink} aria-label="Invite link" />
          <Button type="button" onClick={() => void copy()} variant="secondary" size="sm">
            <IconCopy {...ICON} /> {copied ? "Copied" : "Copy"}
          </Button>
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
        <Button type="button" disabled={busy} onClick={() => void actions.teams({ type: "leaveTeam" })} variant="link" size="sm">
          Leave team
        </Button>
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
