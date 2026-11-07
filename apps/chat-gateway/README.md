# chat-gateway

The live half of Nexus Messages. Django (`plane.chat`) owns all chat data and permissions; this service only
pushes updates to browsers. **It never writes data**: sending, editing, joining and everything else goes through
the REST API at `/api/workspaces/<slug>/chat/`. It holds no database credentials and no secrets: it asks the
Plane API about the user's own session cookie.

```
browser ──WS /chat/ws?workspace=<slug> (cookie)──▶ chat-gateway ──GET with the user's cookie──▶ API
                                                        ▲
                       Redis pub/sub chat:workspace:<id> ┘ (published by Django after each write commits)
```

## Endpoints

- `GET /chat/ws?workspace=<slug>`: WebSocket upgrade. In order:
  1. Origin check (the socket is authenticated by cookie, so another site must not be able to open it).
  2. The `Cookie` header must be present.
  3. In parallel, with that cookie: `GET /api/users/me/` (who is this) and `GET /api/workspaces/<slug>/` (are
     they an active member; it also gives the workspace ID).
  4. Per-user and overall connection caps.
- `GET /chat/health`: liveness and the open connection count.

Only the `Cookie` header is read. Plane's `session-id` cookie is `HttpOnly`, so page JavaScript can't read it to
put anywhere else, and the gateway takes nothing from the URL.

A refusal still completes the WebSocket upgrade and then closes with a code, because a browser can't see why a
failed HTTP upgrade failed.

| Close code | Meaning                                         | The client should                    |
| ---------- | ----------------------------------------------- | ------------------------------------ |
| 4400       | Missing or malformed `workspace`                | not retry                            |
| 4401       | No cookie, or the API doesn't accept it         | send the user to sign in             |
| 4403       | Not a member of this workspace (any more)       | not retry                            |
| 4429       | Too many sockets open, or too many frames sent  | back off, then retry                 |
| 1011       | The API couldn't be reached to check the cookie | retry with backoff                   |
| 1001       | The gateway is shutting down                    | reconnect, then fetch what it missed |

## Frames

JSON text frames, each an object with a `type`.

- Browser → gateway: `{"type":"ping"}`.
- Gateway → browser: `{"type":"ready","user_id","workspace_id"}` once admitted; `{"type":"pong"}`;
  `{"type":"error","code":"bad_request","message"}` for a frame it can't use (the socket stays open).

## Configuration

| Variable                                | Default | Meaning                                                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `API_BASE_URL`                          | —       | The Plane API, e.g. `http://api:8000`. Required.                                |
| `PORT`, `HOST`                          | 3420    | Where to listen.                                                                |
| `CHAT_GATEWAY_BASE_PATH`                | `/chat` | Mount point; the socket is `<base>/ws`, health is `<base>/health`.              |
| `CORS_ALLOWED_ORIGINS`                  | (own)   | Browser origins allowed to open the socket; empty means the gateway's own host. |
| `CHAT_GATEWAY_MAX_CONNECTIONS_PER_USER` | 8       | Open sockets per user (a few tabs).                                             |
| `CHAT_GATEWAY_MAX_CONNECTIONS`          | 2000    | Open sockets overall.                                                           |
| `CHAT_GATEWAY_MAX_MESSAGE_BYTES`        | 16384   | Largest frame accepted from a browser.                                          |
| `CHAT_GATEWAY_PING_INTERVAL_MS`         | 30000   | WebSocket ping interval; a peer that misses one is dropped.                     |

## Development

```
pnpm turbo run check:lint check:types --filter=chat-gateway
pnpm --filter chat-gateway test
```

The tests run the real gateway against a stub of the Plane API (`tests/helpers/stub-api.ts`).
