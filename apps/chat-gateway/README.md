# chat-gateway

The live half of Nexus Messages. Django (`plane.chat`) owns all chat data and permissions; this service only
pushes updates to browsers. **It never writes data**: sending, editing, joining and everything else goes through
the REST API at `/api/workspaces/<slug>/chat/`. It holds no database credentials and no secrets: it asks the
Plane API about the user's own session cookie.

```
browser ──WS /chat/ws?workspace=<slug> (cookie)──▶ chat-gateway ──GET, with the user's cookie──▶ API
   ▲                                                     ▲
   └── events, only for channels the user may see        └── Redis pub/sub chat:workspace:<id>
                                                             (Django publishes after each write commits)
```

## Endpoints

- `GET /chat/ws?workspace=<slug>`: WebSocket upgrade. In order:
  1. Origin check (the socket is authenticated by cookie, so another site must not be able to open it).
  2. The `workspace` parameter and the `Cookie` header must be present, and the gateway must have room, so a
     refused or full connection costs the API nothing.
  3. In parallel, with that cookie: `GET /api/users/me/` (who is this) and `GET /api/workspaces/<slug>/chat/me/` (are
     they an active member; it also gives the workspace ID).
  4. Events must be flowing (Redis is up), then the per-user and overall connection caps.
  5. The socket opens. The gateway starts listening to the workspace's events, reads the user's channels
     (`GET chat/channels/`, live and archived), and sends `ready`.
- `GET /chat/health`: liveness, the open connection count, and whether Redis is up.

Only the `Cookie` header is read. Plane's `session-id` cookie is `HttpOnly`, so page JavaScript can't read it to
put anywhere else, and the gateway takes nothing from the URL.

A bad `Origin` or path gets a plain HTTP error. Any other refusal completes the WebSocket upgrade and then closes
with a code, because a browser can't see why a failed HTTP upgrade failed.

| Close code | Meaning                                            | The client should        |
| ---------- | -------------------------------------------------- | ------------------------ |
| 4400       | Missing or malformed `workspace`                   | not retry                |
| 4401       | No cookie, or the API doesn't accept it (any more) | send the user to sign in |
| 4403       | Not a member of this workspace (any more)          | not retry                |
| 4429       | Too many sockets open, or too many frames sent     | back off, then retry     |
| 1011       | The API or Redis couldn't be reached               | retry with backoff       |
| 1013       | The socket wasn't keeping up with the events       | reconnect, then resync   |
| 1001       | The gateway is shutting down                       | reconnect, then resync   |

## Frames

JSON text frames, each an object with a `type`. After `ready`, the browser should treat anything that may have
happened while it was not connected as unknown, and fetch it over REST (`messages/?after=<last id>`).

Browser → gateway:

| Frame                                 | Meaning                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `{"type":"ping"}`                     | Answered with `pong`, so the page can tell a dead socket.        |
| `{"type":"subscribe","channel_id"}`   | Also follow a public channel the user can see but hasn't joined. |
| `{"type":"unsubscribe","channel_id"}` | Stop following it. A channel the user is in is always followed.  |

Gateway → browser:

| Frame                                             | Meaning                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready {user_id, workspace_id, channels}`         | Admitted. `channels` are the ones the user is in, followed from now on. Wait for it.                                                                               |
| `event {event}`                                   | A chat event (below) for a channel the user may see.                                                                                                               |
| `subscribed`, `unsubscribed {channel_id, reason}` | `reason` is `requested`, or `access_lost` when the channel is no longer visible to the user.                                                                       |
| `resync {reason}`                                 | `events_missed` (Redis dropped) or `membership_changed` (the user's channels changed without an event): refetch the channel list and each open channel's messages. |
| `pong`                                            | Answer to `ping`.                                                                                                                                                  |
| `error {code, message, channel_id?}`              | `bad_request`, `not_found`, `too_many_subscriptions` or `unavailable`. The socket stays open.                                                                      |

## Events

Django publishes one JSON object per change to `chat:workspace:<workspace_id>` once the write has committed
(`apps/api/plane/chat/events.py` is the other half of this contract and lists what each write publishes). The
gateway forwards exactly these fields and no others: `type`, `workspace_id`, `channel_id?`, `message_id?`,
`parent_id?`, `user_id?`, `actor_id?`, `at`. IDs only; the browser fetches what it needs over REST, where
permissions are enforced.

Types: `message.created|updated|removed`, `channel.created|updated|archived|unarchived`,
`member.added|removed|updated`, `read.updated`, `access.revoked`.

### Who gets an event

Every event for a workspace is handed to every socket in it, and a socket forwards it only if it follows the
channel, which it does in one of two ways:

- **its feed**: the channels the user is a member of. Read from the API when the socket opens, kept current from
  `member.added` / `member.removed` events about the user, and read again every `CHAT_GATEWAY_ACCESS_TTL_MS`.
  A channel starts to follow when the user is added to it, so the first thing a user hears of a new channel or
  DM is their own `member.added`: the browser fetches the channel over REST then.
- **subscriptions**: public channels the user can see but hasn't joined, which the browser asked for. The API is
  asked as that user (`GET chat/channels/<id>/`: 200, or 404 for anything they can't see) and the answer is
  re-checked with the feed. A refusal is remembered for the same TTL.

Two events are about the user rather than a channel:

- `read.updated` goes only to the sockets of the user whose read position it is.
- `member.removed` about the user is forwarded, so they learn they are out, and then the channel stops.

### Revocation

- `member.removed` about the user: immediate, as above.
- `access.revoked` (the user left or was removed from the workspace): the socket stops sending at once, asks the
  API again, and closes with 4403 (or 4401 if the cookie is gone too). If the user turns out to still be a member
  it carries on and sends `resync`. If the API can't be asked, it closes rather than guess.
- Anything an event didn't cover (a missed event, a demotion to guest, a deleted channel) is caught within
  `CHAT_GATEWAY_ACCESS_TTL_MS` by re-reading the user's channels, and the cookie and workspace membership are
  checked again every `CHAT_GATEWAY_SESSION_RECHECK_MS`. A failed check closes the socket; an API outage doesn't.

### When events are missed

Redis pub/sub keeps nothing. If the gateway's Redis connection drops, it resubscribes first and only then sends
every socket `resync {reason:"events_missed"}`. A browser that disconnects simply reconnects and fetches what it
missed with `messages/?after=<id>`. Events that arrive while a socket is still reading the user's channels are held
and sent after `ready`, in order.

## Configuration

| Variable                                      | Default     | Meaning                                                                          |
| --------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `API_BASE_URL`                                | —           | The Plane API, e.g. `http://api:8000`. Required.                                 |
| `REDIS_URL`                                   | —           | The Redis (or Valkey) Django publishes to, i.e. the API's `REDIS_URL`. Required. |
| `PORT`, `HOST`                                | 3420        | Where to listen.                                                                 |
| `CHAT_GATEWAY_BASE_PATH`                      | `/chat`     | Mount point; the socket is `<base>/ws`, health is `<base>/health`.               |
| `CORS_ALLOWED_ORIGINS`                        | (own)       | Browser origins allowed to open the socket; empty means the gateway's own host.  |
| `CHAT_GATEWAY_MAX_CONNECTIONS_PER_USER`       | 8           | Open sockets per user (a few tabs).                                              |
| `CHAT_GATEWAY_MAX_CONNECTIONS`                | 2000        | Open sockets overall.                                                            |
| `CHAT_GATEWAY_MAX_SUBSCRIPTIONS`              | 100         | Public channels one socket may follow beyond its own.                            |
| `CHAT_GATEWAY_MAX_MESSAGE_BYTES`              | 16384       | Largest frame accepted from a browser.                                           |
| `CHAT_GATEWAY_RATE_FRAMES`, `_RATE_WINDOW_MS` | 100 / 10000 | Frames (WebSocket pings included) one socket may send per window before 4429.    |
| `CHAT_GATEWAY_MAX_BUFFERED_BYTES`             | 1048576     | A socket with more than this unsent is too slow and is closed (1013).            |
| `CHAT_GATEWAY_ACCESS_TTL_MS`                  | 60000       | How long what the API said about a user's channels is trusted.                   |
| `CHAT_GATEWAY_SESSION_RECHECK_MS`             | 300000      | How often each socket's cookie and workspace membership are checked again.       |
| `CHAT_GATEWAY_PING_INTERVAL_MS`               | 30000       | WebSocket ping interval; a peer that misses one is dropped.                      |
| `CHAT_GATEWAY_CLOSE_TIMEOUT_MS`               | 5000        | How long a browser gets to finish closing a socket before it is cut.             |
| `CHAT_GATEWAY_MAX_API_CONCURRENCY`            | 32          | Most API calls under way at once, across every socket; the rest wait their turn. |

## Scaling notes

Each socket re-reads its user's channel list (two API calls) every `CHAT_GATEWAY_ACCESS_TTL_MS`, as that user, at a
point in the interval picked at random so that sockets opened together don't re-read together, and no more than
`CHAT_GATEWAY_MAX_API_CONCURRENCY` calls run at once. That is cheap for a team and costs more as sockets grow, since
the list endpoint computes unread counts. Raise the TTL (the events keep the feed current in between), or share the
read between one user's sockets, before it matters.
The gateway keeps no state between connections beyond what is in memory, so several instances can run behind one
router; each listens to Redis itself.

## Development

```
pnpm turbo run check:lint check:types --filter=chat-gateway
pnpm --filter chat-gateway test
```

The tests run the real gateway against a stub of the Plane API (`tests/helpers/stub-api.ts`) and publish events
the way Django does. They run over an in-process bus and, when a Redis is reachable, over real Redis too (and those
tests are reported as skipped when it isn't). Point them at one with `CHAT_GATEWAY_TEST_REDIS_URL` (default
`redis://127.0.0.1:6379`), for example:

```
docker run --rm -p 6390:6379 valkey/valkey:7.2.11-alpine
CHAT_GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:6390 pnpm --filter chat-gateway test
```
