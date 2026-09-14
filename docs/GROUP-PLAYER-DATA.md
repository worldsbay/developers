# Player data for your worlds

Open **Connect a world → World groups → your group → Player data**. Create a collection, define its properties, then choose **No access**, **Read**, or **Read & write** for each approved world. Joining a group never grants data access, including to your own worlds. Removing or disabling a world clears its grants. Saved values stay in the original group when a world moves.

Use separate collections when permissions differ: shared progression, a private world save, and arena results might each need different readers and writers. Alice and Bob always have separate values. Collection properties support booleans, bounded safe integers, bounded UTF-8 text, choices, and small sets of IDs. Text limits use `maxBytes`; integer definitions use inclusive `min` and `max`; ID sets use `maxItems`.

The editor saves valid definitions immediately without grants. Keys, types, defaults and bounds remain fixed. You can change labels and add properties; a new meaning needs a new collection. Added properties appear at their defaults without allocating or rewriting player saves. There is no collection deletion in v1. Usage includes definitions, grants and retained saves, with a limit of 16 collections, 64 MiB and 10,000 saves per group.

## Try access and conflicts

Expand **Try it with sample players** in a collection. This local simulation uses the saved definition and permissions. It does not read or write real saves, and reopening the collection resets sample data.

1. Give Forest and Arena Read & write, and Hub Read. Keep another world at No access.
2. Choose Alice and read in Forest, then read in Arena.
3. Update `{"experience":25}` in Arena. Its display changes immediately.
4. Switch to Forest. Its display is still the old snapshot. An update conflicts; an explicit read gets 25.
5. Hub can read but cannot update. A world with No access cannot read either.
6. Switch to Bob to see separate default values. Change a grant and reopen the playground to test the new access.

For real end-to-end testing, the operator must enable your one test group with `PLAYER_DATA_TEST_GROUP=<group-id>`. Use two world servers with accepted sessions for the same test player. Run the sequence above through the server SDK, then remove/rejoin a world and verify its grant is gone. Live saves are an alpha rollout; the local playground is available without live enablement.

## Server SDK

Install `@worldsbay/api` version 0.1.3 or newer. The server client includes a session-scoped data helper:

```js
import { WorldClient, RequestError } from '@worldsbay/api/server';

const central = new WorldClient({ centralUrl, worldId, worldSecret });
// Use the accepted central grant from the player's server-side session.
const data = central.playerData(playerSession);
const progress = await data.read(collectionId);
// Validate the quest completion on your game server before saving.
try {
  const saved = await data.update(collectionId, {
    expectedVersion: progress.version,
    changes: { experience: progress.values.experience + 25 },
  });
  // Send saved.values through your game's own UI update mechanism.
} catch (error) {
  if (error instanceof RequestError && error.apiCode === 'VERSION_CONFLICT') {
    // error.snapshot is the current snapshot. Reconsider the action explicitly.
  }
  // Show the save as failed/unknown as appropriate. Do not award it again automatically.
}
// At sign-out, travel-session replacement or account switch:
data.dispose();
```

Keep one helper per accepted player session, dispose it when that session ends, and await an operation before starting another for the same collection. Concurrent operations for that collection are rejected immediately; there is no pending write queue. The helper retains at most 16 snapshots, returns copies, and discards late responses after disposal. It never retries writes or merges conflicts.

World credentials and player sessions stay on your server. Do not add a generic browser proxy for these operations. Expose validated game actions such as completing a quest. Write access trusts the world's game results; it does not prove that gameplay happened and never grants platform inventory or account privileges.

## HTTP contract

Use HTTPS outside loopback development, `Authorization: Bearer <world-secret>`, `X-World-ID`, and `X-World-Session` once each. No browser Origin header is accepted. Player identity comes only from the session.

| Route | Result |
| --- | --- |
| `GET /internal/player-data/:collectionId` | `{version, values}`; missing saves use version `"0"` and defaults |
| `PATCH /internal/player-data/:collectionId` | Body `{expectedVersion, changes}`; returns the complete saved snapshot |
| `GET /internal/player-data/collections` | At most 16 accessible IDs, names and permissions; no values or definitions |

Updates accept 1–16 defined property keys. Omitted values remain unchanged. Submit a complete bounded ID set to change it. No-op writes keep the version and do not allocate a save. A reset to defaults retains an empty save with a fresh opaque version.

`VERSION_CONFLICT` (409) includes `snapshot`. Do not automatically reapply against it. After a timeout, the outcome is unknown: retrying the original version cannot apply a changing write twice, but a subsequent conflict does not prove which request succeeded. There are no exactly-once reward guarantees.

Other stable codes include `INVALID_INPUT` (400), `INVALID_SESSION` (401), `READ_ONLY` (403), `NOT_FOUND` (404), `QUOTA_EXCEEDED` (409), `THROTTLED` (429, with Retry-After), and storage/accounting unavailability (503). All responses are no-store. Strict JSON rejects duplicate decoded names, prototype keys, malformed Unicode, unknown fields, compression, depth over eight and unsafe numbers. V1 requires integer numeric tokens without decimal or exponent notation. Requests/responses are capped at 16 KiB; values per player/collection at 8 KiB.

Owner management uses the central saved-account browser session and matching-origin mutation headers. `GET/POST /api/groups/:group/player-data` lists usage/collections or creates a definition. `GET/PATCH .../:id` reads or updates one definition; a PATCH includes `{expectedVersion, definition}`. `PATCH .../:id/access` takes `{expectedVersion, worldId, permission}` with `none`, `read`, or `write`. The editor handles configuration versions. A stale tab receives `CONFIG_CONFLICT` and must reopen the collection.

Guests retain saves for 30 days after a changing write while no accepted session remains in an active approved world of that group. Reads do not extend retention. Saving the same guest account preserves its data; signing into another existing account does not merge it. Saved-account progress has no automatic expiry. Account deletion deletes its saves and releases usage.

There is no background game polling, live cross-world push, automatic merge, increment endpoint, or offline queue. Read on entry and when a game action needs fresh progress; batch related changes into one update.
