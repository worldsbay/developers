# Start a world

The starter uses the official `@worldsbay/api` npm package. Its `/client/runtime/sdk.js` endpoint is a browser bundle of that package, not a separate SDK implementation. Custom bundled games can import directly from `@worldsbay/api`.

The starter runs your scene and multiplayer server. WorldsBay handles player accounts, entry and saved appearance. You need Node.js 22.12 or later and a public HTTPS hostname dedicated to your world.

## Connect

Clone the official source before configuring it:

```sh
git clone https://github.com/worldsbay/developers.git my-world
cd my-world
```

1. Save an account at [WorldsBay](https://worldsbay.com), then open [Connect](https://worldsbay.com/connect).
2. Register your world with an HTTPS origin on port 443, such as `https://your-world.example`. Use a separate hostname from WorldsBay and other connected worlds: changing a port or path does not isolate cookies.
3. Copy `.env.example` to `.env`. Fill in the registered world ID, private server key, world URL and name. Keep `CENTRAL_URL=https://worldsbay.com`.
4. Download the registration's `worldsbay.json` and place it beside `server.mjs`.
5. Install, build and start from the repository root:

   ```sh
   npm ci
   npm run build
   npm start
   ```

6. Route your HTTPS hostname to your world server’s listening address. Forward WebSocket upgrades for `/room`. Preserve the original host and HTTPS scheme, and overwrite forwarded client-IP headers with the actual client IP. The starter trusts a proxy on the same machine.
7. Choose **Verify & connect** in the builder desk, then enter your world from WorldsBay.

The server exposes the registration proof at `/.well-known/worldsbay.json`. Verification makes the world available without a central restart. Opening the world URL directly offers guest entry, account creation and sign-in. Returning players can resume their remembered identity in the world.

`.env` stays private. The verification JSON is served publicly by design, but belongs to your individual registration and should stay out of the shared repository. Serve only the configured public directories, not the repository root.

## Make it yours

| File                                                  | What to change                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| [`public/client.js`](../public/client.js)             | Scene construction, colors and custom visuals                   |
| [`public/index.html`](../public/index.html)           | Page title and the scene's HTML shell                           |
| [`server.mjs`](../server.mjs)                         | Spawn, collision bounds, portals, room limit and world metadata |
| [`packages/wire/world.ts`](../packages/wire/world.ts) | The accepted world-definition shape                             |

Keep the scene and server collision definitions in agreement. Portal targets are registered world IDs or `random`. The default room holds 16 players; the definition supports up to 32, which is a configuration limit rather than a capacity guarantee. Restart your world server after changing its configuration. Rebuild after changing TypeScript packages.

The included `startWorld()` adapter supplies movement, other players, chat, appearance rendering and travel controls. Preserve its HTML elements when editing the shell. For an existing game or another browser renderer, use the [SDK integration guide](AGENT-INTEGRATION.md).

## Characters and accounts

Saved classic and modular avatars render automatically. This checkout contains no character binary library: the world server retrieves approved files from WorldsBay and checks their hashes before serving them. It cannot fetch arbitrary URLs supplied by players.

Character editing opens on WorldsBay and returns the player to your world. Your game does not need account passwords or identity-provider credentials. See [character integration](CHARACTER-BUILDER.md).

## Verify your changes

Run `npm run check` for the repository's type, build and test checks. Then use two separate browser sessions to enter, move, chat, edit a character and travel away and back. Check your public `/health` and verification routes if registration fails; check WebSocket forwarding if entry succeeds but the room does not connect.

World sessions and room state live in memory. After a restart, returning players can resume using their remembered world cookie; an interrupted sign-in must be started again. Keep your starter updated from [the repository](https://github.com/worldsbay/developers); an installed copy does not update itself.

[Back to the README](../README.md)

## WorldsBay connection settings

Add the values from registration to your world server’s private environment:

```dotenv
CENTRAL_URL=https://worldsbay.com
WORLD_ID=wb-your-registered-world-id
WORLD_URL=https://your-world.example
WORLD_SECRET=your-private-registration-key
```

`CENTRAL_URL` identifies WorldsBay. `WORLD_ID` and `WORLD_SECRET` authenticate your world server. `WORLD_URL` is the public HTTPS origin players visit and WorldsBay verifies, such as `https://luthadelatnight.com`. Keep the private key on the server.
