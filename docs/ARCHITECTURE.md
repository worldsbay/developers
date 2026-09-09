# Integration contract

Your server owns gameplay. WorldsBay owns player accounts, wardrobe and world registration. The browser talks to your server using a local session cookie; only your server holds the world credential. This repository includes the world server and browser runtime, not the central account service.

## Entry and session lifetime

1. WorldsBay issues a single-use entry ticket for one player and destination, valid for 60 seconds.
2. The browser navigates to your `/enter?ticket=...` route.
3. Your server exchanges that ticket for a world-bound grant. It stores the grant behind a random local cookie and acknowledges acceptance to WorldsBay.
4. If acceptance fails, the server discards the local session. Otherwise it sends the cookie and redirects to `/`, removing the ticket before scene assets load.
5. The accepted grant authorizes appearance reads, travel and wardrobe context for that player in that world.

The current grant lifetime is one hour. Use the returned `expiresAt`; reconnecting does not extend it. The HTTPS cookie is host-only, HttpOnly, Secure and SameSite=Lax, with a one-hour maximum age. Local sessions are held in memory and disappear on restart. Central logout does not immediately end already-issued world grants.

Acceptance records the completed server handshake. It does not prove that the scene rendered. Entry tickets, grants and account passwords never belong in room messages or browser storage.

## Browser routes on your world

Read routes below that say **session** require the accepted local cookie. POST routes also require the exact world `Origin`, JSON, and `X-WorldsBay: 1`; the SDK supplies the header. Browser mutations reject bearer authorization.

| Method and route                  | Access                              | Result or input                                                        |
| --------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `GET /health`                     | Public                              | `{ ok: true, service: worldId }`                                       |
| `GET /.well-known/worldsbay.json`  | Public, when configured             | Registration proof                                                     |
| `GET /api/config`                 | Public                              | `{ world, homeUrl }`                                                   |
| `GET /enter?ticket=...`           | Entry ticket                        | Exchange, cookie and redirect                                          |
| `GET /api/session`                | Session                             | `{ world, homeUrl, destinations, appearance, expiresAt }`              |
| `GET /api/appearance`             | Session                             | Current authorized `Appearance`                                        |
| `POST /api/travel`                | Session + Origin/header             | `{ worldId }` → `{ url, expiresIn }`                                   |
| `POST /api/store`                 | Session + Origin/header             | `{ selectedItem? }` → `{ url }`                                        |
| `GET /api/collection`             | Session                             | Listed items, filtered by the world's configured item IDs when present |
| `GET /api/room-metrics`           | Session                             | Aggregate diagnostics for this world                                   |
| `GET /avatar-assets/<sha256>.glb` | Previously admitted asset reference | Hash-checked avatar bytes                                              |
| `WebSocket /room`                 | Session + exact Origin              | Room protocol; query strings are rejected                              |

`destinations` contains routes allowed by this world's portals, not necessarily every registered world. The server caches the central registry for 30 seconds. Failed travel leaves the current scene available; navigate only after receiving a successful URL.

## Calls from your server to WorldsBay

The included adapter uses `WorldClient` from `@worldsbay/api/server` for these calls, including credentials, timeouts and redirect rejection. `WorldClient.request()` supports the internal routes used by the adapter. Keep this import on the server.

All internal routes require `Authorization: Bearer <WORLD_SECRET>` and `X-World-ID: <WORLD_ID>`. Requests carrying a browser `Origin` are rejected. Player-specific routes additionally require `X-World-Session: <grant>`. Send JSON for request bodies.

| Method and route           | Body                | Grant required         | Response                   |
| -------------------------- | ------------------- | ---------------------- | -------------------------- |
| `POST /internal/exchange`  | `{ token }`         | No                     | `{ session, expiresAt }`   |
| `POST /internal/accept`    | None                | Yes; may be unaccepted | `{ ok: true }`, idempotent |
| `GET /internal/worlds`     | None                | No                     | Registered public worlds   |
| `GET /internal/appearance` | None                | Accepted               | Authorized `Appearance`    |
| `GET /internal/catalogue`  | None                | Accepted               | Listed catalogue items     |
| `POST /internal/travel`    | `{ worldId }`       | Accepted               | Entry `{ url, expiresIn }` |
| `POST /internal/store`     | `{ selectedItem? }` | Accepted               | Central wardrobe `{ url }` |

The wardrobe context lasts five minutes and is bound to the same player. It is a navigation context, not a login credential. Listed items are free to claim through the central wardrobe; these APIs do not authorize inventory writes. The included [`createWorld`](../apps/world/server.ts) adapter implements the handshake and calls above.

## Multiplayer and appearance

The supplied room uses protocol 1, 20 simulation steps per second and 10 snapshots per second. Clients send bounded movement intent; the server calculates positions, collisions and built-in interactions. A new connection for the same player replaces the previous one. Room snapshots use opaque actor IDs and share worn appearance, not account credentials or unworn inventory.

The SDK emits `welcome`, `snapshot`, `appearance`, `chat`, `chatError`, `state`, `central` and `error` events. `welcome` includes initial appearances and recent room chat. Appearance updates normally refresh every four seconds. Use revision ordering so a late asset load cannot replace a newer look.

Accepted sessions can continue local gameplay during a central outage until their original expiry, provided their required assets have already loaded. Entry, travel and fresh appearance reads still depend on WorldsBay. Authorization failures end the session; an outage must not extend a grant.

The world proxy admits only content-addressed GLBs named by authorized appearances from the configured central origin. It rejects arbitrary asset URLs and checks downloaded hashes. This checkout omits the optional local character library, so initial character loads use that central fallback.

For a custom game, extend your server-side rules and protocol deliberately. Extra client fields, claimed positions, unknown actions and invalid sequences are rejected by the existing room. See [SDK integration](AGENT-INTEGRATION.md) and the actual [wire types](../packages/wire/room.ts).

[Back to the README](../README.md)
