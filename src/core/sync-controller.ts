import type { TeamsAction, TeamsActionResult, TeamsPublishRequest, TeamsTickResult, TeamsView } from "../shared/ipc";
import { IDLE_TRACKER, stepTracker, type MeetingTracker } from "./meeting-tracker";
import { RelayError, createRelayClient } from "./relay-client";
import { formatInviteCode, inviteLink, parseInviteCode, type Member, type Presence, type Room, type Team } from "./relay-protocol";
import { inviteRoster, mergeCandidate, rankRooms } from "./room-picker";
import { addClockSample, clockOffset, phraseToLine, shouldShare, type ClockSample, type SessionLine } from "./sync-lines";

// Teams mode state for one device: detection → popup → sync room → phrases. No Electron here, so tests drive it
// with the in-memory relay and a stub detector. Every relay failure falls back to solo (fail open).

export type DetectorReading = { inMeeting: boolean; source: "windows" | "none" };

// Re-read team membership this often, so removals and renames show up.
const TEAM_REFRESH_MS = 60_000;
// Presence is re-sent at least this often; the relay treats it as stale after PRESENCE_STALE_MS.
const PRESENCE_HEARTBEAT_MS = 20_000;

export type SyncController = ReturnType<typeof createSyncController>;

export function createSyncController(deps: {
  relayUrl: string | null;
  readDetector: () => Promise<DetectorReading>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timing?: { enterMs: number; leaveMs: number };
}) {
  const now = deps.now ?? Date.now;
  let samples: ClockSample[] = [];
  const client = deps.relayUrl
    ? createRelayClient({ baseUrl: deps.relayUrl, fetch: deps.fetch, now, onClock: (sample) => (samples = addClockSample(samples, sample)) })
    : null;

  let me: Member | null = null;
  let team: Team | null = null;
  let teamCheckedAt = 0;
  let tracker: MeetingTracker = IDLE_TRACKER;
  let source: DetectorReading["source"] = "none";
  let simulated = false;
  let dismissedEpoch = 0;
  let room: Room | null = null;
  // Epoch of the detection the room was joined under; null when started by hand. Only those rooms auto-leave.
  let roomEpoch: number | null = null;
  let cursor = 0;
  let rooms: Room[] = [];
  let presence: Presence[] = [];
  let presenceSent: { inMeeting: boolean; at: number } | null = null;
  const mergeDeclined = new Set<string>();
  let shareMuted = false;
  let relayError: string | null = null;
  let notice: string | null = null;
  let pendingInvite: string | null = null;

  const offset = () => clockOffset(samples);
  const serverNow = () => now() + offset();

  function promptOpen(): boolean {
    return team !== null && room === null && tracker.stable && tracker.epoch !== dismissedEpoch;
  }

  function candidate(): Room | null {
    if (!room || !me) return null;
    const found = mergeCandidate({ rooms, presence, mine: room, now: serverNow() });
    return found && !mergeDeclined.has(found.id) ? found : null;
  }

  function view(): TeamsView {
    const myId = me?.userId ?? "";
    const other = candidate();
    const otherName = other ? (other.members.find((member) => member.userId === other.createdBy)?.displayName ?? "a teammate") : "";
    return {
      relayConfigured: client !== null,
      relayError,
      notice,
      me,
      team: team
        ? { id: team.id, name: team.name, inviteCode: formatInviteCode(team.inviteCode), inviteLink: inviteLink(team.inviteCode), members: team.members }
        : null,
      pendingInvite,
      detection: { inMeeting: tracker.stable, raw: tracker.raw, epoch: tracker.epoch, source: simulated ? "simulated" : source },
      prompt: promptOpen()
        ? { epoch: tracker.epoch, ...rankRooms({ rooms, presence, me: myId, mySince: (tracker.since ?? now()) + offset(), now: serverNow() }) }
        : null,
      room: room
        ? { id: room.id, code: room.code, createdAt: room.createdAt, startedByMe: room.createdBy === myId, members: room.members, invited: room.invited }
        : null,
      roster: room ? inviteRoster({ presence, room, me: myId, now: serverNow() }) : [],
      merge: other && room ? { roomId: other.id, label: `Merge with ${otherName}'s sync?`, waiting: room.mergeWith === other.id } : null,
      shareMuted,
    };
  }

  function setRoom(next: { room: Room; cursor: number }, epoch: number | null): void {
    room = next.room;
    cursor = next.cursor;
    roomEpoch = epoch;
    rooms = [...rooms.filter((entry) => entry.id !== next.room.id), next.room];
  }

  function clearRoom(message: string | null): void {
    room = null;
    roomEpoch = null;
    cursor = 0;
    notice = message;
  }

  /** Relay errors: 403/404 on a room ends it locally; "Not on a team" clears the team; anything else is solo mode. */
  function absorb(error: Error): string {
    const message = error.message;
    if (error instanceof RelayError && error.status === 403 && message === "Not on a team") {
      team = null;
      clearRoom(null);
    } else if (error instanceof RelayError && (error.status === 403 || error.status === 404) && room) {
      clearRoom("The sync ended.");
    }
    const down = !(error instanceof RelayError) || error.status === 0 || error.status === 401 || error.status >= 500;
    if (down) relayError = `${message}. Bee is working solo.`;
    return message;
  }

  /** Runs a relay step; resolves to its error message (already absorbed), or null. */
  function attempt(task: () => Promise<void>): Promise<string | null> {
    return task().then(
      () => null,
      (error: Error) => absorb(error instanceof Error ? error : new Error(String(error))),
    );
  }

  async function refreshTeam(token: string): Promise<void> {
    if (!client) return;
    const result = await client.me(token);
    me = { userId: result.userId, displayName: result.displayName ?? "You" };
    team = result.team;
    teamCheckedAt = now();
    if (!team) clearRoom(null);
  }

  async function leaveRoom(token: string): Promise<void> {
    const current = room;
    clearRoom(null);
    if (client && current) await client.leaveRoom(token, current.id);
  }

  async function pollRoom(token: string): Promise<SessionLine[]> {
    if (!client || !room) return [];
    const polled = await client.phrases(token, room.id, cursor);
    if (polled.room.mergedInto) {
      // Both rooms tapped Merge; the relay already moved us.
      setRoom(await client.joinRoom(token, { roomId: polled.room.mergedInto }), roomEpoch);
      notice = "Syncs merged.";
      return [];
    }
    room = polled.room;
    for (const phrase of polled.phrases) cursor = Math.max(cursor, phrase.seq);
    return polled.phrases.filter((phrase) => phrase.speakerId !== me?.userId).map((phrase) => phraseToLine(phrase, offset()));
  }

  async function tick(token: string): Promise<TeamsTickResult> {
    let lines: SessionLine[] = [];
    if (!client) return { view: view(), lines };
    const error = await attempt(async () => {
      if (teamCheckedAt === 0 || now() - teamCheckedAt > TEAM_REFRESH_MS) await refreshTeam(token);
      // The detector only runs for people on a team (tasklist is not free).
      const reading = team ? await deps.readDetector().catch((): DetectorReading => ({ inMeeting: false, source: "none" })) : null;
      source = reading?.source ?? "none";
      tracker = stepTracker(tracker, simulated || (reading?.inMeeting ?? false), now(), deps.timing);
      if (team) {
        // Teams left the meeting (after the debounce), or a new meeting began: end the sync. Never auto-rejoin.
        if (room && roomEpoch !== null && (!tracker.stable || tracker.epoch !== roomEpoch)) await leaveRoom(token);
        const inMeeting = tracker.stable;
        if (!presenceSent || presenceSent.inMeeting !== inMeeting || now() - presenceSent.at > PRESENCE_HEARTBEAT_MS) {
          presence = (await client.setPresence(token, inMeeting)).presence;
          presenceSent = { inMeeting, at: now() };
        }
        lines = await pollRoom(token);
        if (promptOpen() || room) {
          const listed = await client.listRooms(token);
          rooms = listed.rooms;
          presence = listed.presence;
        }
      }
    });
    if (!error) relayError = null;
    return { view: view(), lines };
  }

  async function run(action: TeamsAction): Promise<void> {
    const token = action.sessionToken;
    if (action.type === "dismissPrompt") {
      dismissedEpoch = tracker.epoch;
      return;
    }
    if (action.type === "setShareMuted") {
      shareMuted = action.muted;
      return;
    }
    if (action.type === "simulateMeeting") {
      simulated = action.on;
      return;
    }
    if (action.type === "copyInvite") return;
    if (!client) throw new Error("Teams mode needs BEE_RELAY_URL.");
    notice = null;
    const epoch = tracker.stable ? tracker.epoch : null;
    switch (action.type) {
      case "createTeam":
        await client.createTeam(token, action.name, action.displayName);
        await refreshTeam(token);
        return;
      case "joinTeam": {
        const code = parseInviteCode(action.code);
        if (!code) throw new Error("That invite code does not look right. It has 8 letters and numbers.");
        await client.joinTeam(token, code, action.displayName);
        pendingInvite = null;
        await refreshTeam(token);
        return;
      }
      case "leaveTeam":
        await leaveRoom(token);
        await client.leaveTeam(token);
        team = null;
        return;
      case "startSync":
        setRoom(await client.createRoom(token, action.invite), epoch);
        return;
      case "joinSync":
        setRoom(await client.joinRoom(token, { roomId: action.roomId }), epoch);
        return;
      case "joinSyncByCode":
        setRoom(await client.joinRoom(token, { code: action.code }), epoch);
        return;
      case "leaveSync":
        await leaveRoom(token);
        // No second popup for the same meeting.
        dismissedEpoch = tracker.epoch;
        return;
      case "invite":
        if (room) setRoom(await client.invite(token, room.id, action.userIds), roomEpoch);
        return;
      case "merge": {
        const other = candidate();
        if (!other || !room) return;
        if (!action.accept) {
          mergeDeclined.add(other.id);
          return;
        }
        const result = await client.requestMerge(token, room.id, other.id);
        setRoom({ room: result.room, cursor: result.room.id === room.id ? cursor : result.cursor }, roomEpoch);
        return;
      }
    }
  }

  return {
    tick,

    async act(action: TeamsAction): Promise<TeamsActionResult> {
      const error = await attempt(() => run(action));
      return { view: view(), error };
    },

    /** Shares one phrase with the sync, if the share gate allows it. Failure never blocks the local pipeline. */
    async publish(request: TeamsPublishRequest): Promise<{ sent: boolean; error: string | null }> {
      const current = room;
      if (!client || !current || !shouldShare({ inRoom: true, shareMuted, source: request.source })) return { sent: false, error: null };
      const error = await attempt(async () => {
        await client.publish(request.sessionToken, current.id, request.text, request.clientTs + offset());
      });
      return { sent: error === null, error };
    },

    setPendingInvite(code: string): void {
      const parsed = parseInviteCode(code);
      pendingInvite = parsed ? formatInviteCode(parsed) : null;
    },

    view,
  };
}
