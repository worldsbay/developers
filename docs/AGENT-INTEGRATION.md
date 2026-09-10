# Connect an existing game

The starter uses the official `@worldsbay/api` npm package. Its `/client/runtime/sdk.js` endpoint is a browser bundle of that package, not a separate SDK implementation. Custom bundled games can import directly from `@worldsbay/api`.

```sh
npm install @worldsbay/api
```

Use `WorldClient` from `@worldsbay/api/server` for your server's central calls. The included
world adapter already uses it; your server still owns local cookies, grant storage and Origin checks.

Keep your game's renderer and gameplay. Use the world server for player entry and the browser SDK for the accepted session, appearance and navigation. Read [the setup guide](WORLD-STARTER.md) and [API contract](ARCHITECTURE.md) first.

## Browser SDK

Follow [the player account flow](PLAYER-ACCOUNT-FLOW.md) for Google signup naming,
guest/saved account menus, editing names and characters, returning to a campaign,
and account deletion. The included starter implements these account bridge routes.

For signin/signup, import `openAccountPage` from `@worldsbay/api` and call
`await openAccountPage(sdk, { mode: 'signin' })` or `{ mode: 'signup' }` from a user
action. This visits central with a browser-bound return flow. `sdk.readAccount()`
returns guest/saved status. `sdk.signOut()` revokes this world's session and
remembered credential: show a retryable error on failure, disconnect and reload
on success. `sdk.startGuest()` and `sdk.resumeSession()` implement direct entry.

Build this repository, then serve the generated runtime with the included world server. The SDK entry is `/client/runtime/sdk.js` on **your world's origin**. Its transitive chunks must remain alongside it. It uses the world's local cookie and contains no Three.js dependency.

```js
import { WorldsBay, RequestError } from '/client/runtime/sdk.js';

const sdk = new WorldsBay();
try {
  const session = await sdk.enterSession();
  // Give session.appearance to your renderer.
  // session.homeUrl is the recovery destination when re-entry is needed.
} catch (error) {
  if (error instanceof RequestError && error.status === 401) {
    // Offer Play as guest (sdk.startGuest()) or sign in with openAccountPage(sdk).
  } else {
    throw error;
  }
}
```

| Method                                                     | Resolves to                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `enterSession()`                                           | World, appearance, permitted destinations, Home URL and session expiry |
| `readAppearance()` / `refreshAppearance()`                 | Latest authorized appearance                                           |
| `getDestinations()`                                        | Permitted destinations from a session read                             |
| `requestTravel(worldId)`                                   | `{ url }` for a registered destination or `random`                     |
| `openStore(selectedItem?)` / `openWardrobe(selectedItem?)` | `{ url }` for the central wardrobe                                     |
| `openCharacterCreator()`                                   | `{ url }` for the central character editor                             |

Navigation methods return a URL. They do not navigate automatically:

```js
// For example, call this from your character-edit button.
async function editCharacter() {
  const { url } = await sdk.openCharacterCreator();
  location.assign(url);
}
```

Use these methods against your own world, with no central credentials in the browser. The optional SDK base argument is a URL prefix, not a cross-origin authentication mechanism.

## Use the included room

```js
import { RoomConnection } from '/client/runtime/sdk.js';

const room = new RoomConnection(() => sdk.enterSession());
const unsubscribe = room.on('snapshot', (snapshot) => {
  // Render snapshot.actors and snapshot.game using your engine.
});
room.on('welcome', ({ actorId, appearances, chatHistory }) => {
  // Save your actorId and load initial appearances and chat.
});
room.on('appearance', ({ actorId, appearance }) => {
  // Replace this actor's look only if the revision is current.
});
room.on('state', (state) => {
  // Present connecting, ready, reconnecting, offline and expired states.
});
room.on('error', (message) => {
  // Show an appropriate connection message in your UI.
});
room.connect();

// From a bounded input loop, while ready. The SDK supplies sequence numbers.
room.send({ type: 'input', x: 0, z: 1, facing: 0, jump: false, run: false });

// On removal of your scene:
// unsubscribe();
// room.dispose();
```

Send input at a bounded rate such as 20 Hz, rather than every render frame. Axes and facing must match the [input schema](../packages/wire/room.ts). `send()` returns the assigned sequence number, or zero if the connection cannot send. The room also accepts `chat`, `emote`, `interact` and diagnostic messages defined in that file; it does not accept arbitrary custom action names.

Listen for `chat` and `chatError` when adding chat. Render player names and chat as text, not HTML. `central` reports whether central appearance refresh is available. The connection retries at most five times and preserves the original session expiry.

If you already have a multiplayer server, keep your own transport. Validate players through the server entry handshake, then adapt the accepted identity to your own server-side session. The HTTP SDK can be used without `RoomConnection`. WorldsBay does not validate your game's combat, scores or economy.

## Use the Three.js adapter

The starter's [`public/client.js`](../public/client.js) demonstrates `startWorld({ createScene })` and `buildWorld()`, exported with `THREE` from `/client/runtime/three.js`. It includes controls, prediction, remote interpolation, avatar presentation and the room UI. Keep the starter HTML shell and `/client/runtime/runtime.css` when using it.

For a custom Three.js scene, `loadAvatar(appearance)` from that entry supports both classic and modular appearances. Update animation each frame and dispose the avatar on removal. Other engines can consume the same validated GLBs using the [rig profiles](RIG-PROFILE.md).

## Integration checks

- Keep the world key and limited grant on the server. Never authenticate a player from a browser-supplied player ID, recipe or URL.
- Preserve HTTPS, distinct hostnames, host-only cookies, exact Origin checks and the acceptance handshake when replacing the server adapter.
- Preserve approved asset references and revision ordering. Never turn the avatar proxy into an arbitrary URL fetcher.
- Run `npm run check`, then exercise two browser sessions: entry, movement, appearance changes and travel. Confirm expired or replayed tickets fail and offline destinations leave a recovery path.

[Back to the README](../README.md)
