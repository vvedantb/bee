# Bee relay

Ephemeral sync rooms for Bee's Teams mode. A Cloudflare Worker sends every request to one Durable Object, which
holds company teams (persisted), presence, rooms and phrases (ephemeral).

Bee never joins the Teams call. Each Bee client sends only its own mute-gated mic phrases, and the relay stamps the
speaker from the verified Clerk session token. It never trusts a name or id sent by the client.

## Environment

| Variable | Where | Required | Meaning |
| --- | --- | --- | --- |
| `CLERK_ISSUER` | Worker (`wrangler.toml` `[vars]`) | Yes | Clerk instance issuer. Default `https://clerk.vedantb.com`. Tokens with another `iss` are rejected. |
| `CLERK_JWKS_URL` | Worker | No | JWKS used to check RS256 signatures. Default `<CLERK_ISSUER>/.well-known/jwks.json`. Cached for 10 minutes, refetched on an unknown `kid` (at most every 30 s). |
| `CLERK_AUTHORIZED_PARTIES` | Worker | No | Comma-separated `azp` allowlist, for example `bee://renderer`. Empty skips the check. |
| `BEE_RELAY_URL` | Bee app (main process env, run time) | For Teams mode | Base URL of this relay, for example `https://bee-relay.<account>.workers.dev`. |
| `MAIN_VITE_BEE_RELAY_URL` | Bee build (`npm run dist:win`) | For installers | The same URL baked into the build. `BEE_RELAY_URL` overrides it. With neither, Teams mode is off. |

Display names come from a `name` claim if the Clerk session token has one (Dashboard → Sessions → Customize session
token: `{"name": "{{user.full_name}}"}`). Otherwise the relay uses the name each user typed when they joined the
team. Users can only set their own name.

## Deploy

```sh
cd relay
npx wrangler login
npx wrangler deploy
```

Then start Bee with `BEE_RELAY_URL=https://bee-relay.<account>.workers.dev`.

## Local

```sh
npm run relay:mock        # in-memory relay on http://127.0.0.1:8787, real Clerk JWKS checks
BEE_RELAY_URL=http://127.0.0.1:8787 npm run dev
```

Unit tests (`relay/src/*.test.ts`, run by `npm test`) use the same handler over a `Map`, with a local RS256 key
pair and JWKS (`test-issuer.ts`). The Teams E2E serves it over HTTP.

## API

All routes need `Authorization: Bearer <Clerk session token>`. Every response has `serverNow` (ms) for clock
offsets. Errors are `{ "error": "…" }` with 400, 401, 403, 404 or 409.

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /v1/me` | | `userId`, `displayName`, `team` |
| `PUT /v1/me` | `displayName` | same |
| `POST /v1/teams` | `name`, `displayName` | `team` (one team per user) |
| `POST /v1/teams/join` | `code` (code or `bee://team/…` link), `displayName` | `team` |
| `POST /v1/team/leave` | | `ok` |
| `PUT /v1/presence` | `inMeeting` | `presence` for the team |
| `GET /v1/presence` | | `presence` |
| `GET /v1/rooms` | | open `rooms` and `presence` for the team |
| `POST /v1/rooms` | `invite` (user ids) | `room`, `cursor`. Leaves any other room first. |
| `POST /v1/rooms/join` | `roomId` or `code` | `room`, `cursor` |
| `POST /v1/rooms/:id/leave` | | `ok` |
| `POST /v1/rooms/:id/invite` | `userIds` | `room`, `cursor` |
| `POST /v1/rooms/:id/merge` | `targetRoomId` | `room`, `cursor`. Merges when both rooms have asked. |
| `POST /v1/rooms/:id/phrases` | `text`, `spokenAt` (server time) | `phrase` with `speakerId`, `speakerName` stamped |
| `GET /v1/rooms/:id/phrases?after=<seq>` | | `room`, `phrases` |

## Rules

- **Team membership** is the allowlist: Clerk user ids added by invite code. Every route checks it.
- **Room ids** are server-issued UUIDv4. Word codes (`amber-otter`) are team-scoped aliases that end with the room.
- **Membership** is whoever clicked Join or Start. The relay never groups people by timing or audio.
- **Retention:** phrases live in the room (last 400) and are deleted when it closes. A room closes when its last
  member leaves, or 4 hours after it started. A member whose client has not polled for 60 s is dropped. No
  transcript is stored long term.
- **Late joiners** get phrases from their join onwards only (no backfill).
- **Scale:** one Durable Object serves every team. That is fine for a few hundred users polling every 2 s. Shard
  by team (`idFromName(teamId)`) before growing past that.
