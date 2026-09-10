# Build with WorldsBay

A multiplayer starter and integration guides using the official API for connecting your game to
[WorldsBay](https://worldsbay.com).

Your world gets a doorway in the hub, shared player accounts, and portable
characters. You control the hosting, scene, and game rules.

## Start a world

Requires **Node.js 22.12+**, your own public HTTPS hostname, and a saved
WorldsBay account.

```sh
git clone https://github.com/worldsbay/developers.git my-world
cd my-world
npm ci
npm run build
```

1. Open the [builder desk](https://worldsbay.com/connect) and register your world.
2. Copy `.env.example` to `.env`, then fill in the private configuration from
   registration. Put the downloaded `worldsbay.json` beside `server.mjs`.
3. Run `npm start`. Point your HTTPS reverse proxy at `127.0.0.1:3003`, with
   WebSocket forwarding for `/room`.
4. Choose **Verify & connect** in the builder desk, then enter through the hub.

Edit `public/client.js` for your scene and `server.mjs` for your world's
definition. The [setup guide](docs/WORLD-STARTER.md) covers hosting and first entry.

## Connect an existing game

Use the official npm package `@worldsbay/api@0.1.1` with the
[server integration contract](docs/ARCHITECTURE.md). The browser build serves it
at `/client/runtime/sdk.js`; `packages/sdk` re-exports the installed package.
With a bundler, import directly from `@worldsbay/api`. The world server uses
`WorldClient` from `@worldsbay/api/server`. Account passwords and identity-provider credentials stay
with WorldsBay; your server receives a limited player session.

- [Coding-agent guide](docs/AGENT-INTEGRATION.md)
- [Characters and wardrobe](docs/CHARACTER-BUILDER.md)
- [Player names, account menus, and returning from the editor](docs/PLAYER-ACCOUNT-FLOW.md)
- [Avatar compatibility](docs/RIG-PROFILE.md)

The starter includes multiplayer movement, shared interactions, portals, and
character rendering. Approved character files load from WorldsBay as players
arrive and are checked against their content hashes. The full model library is
not needed in this checkout.

## Development

Players can start as guests, save or switch accounts, sign out, and use **Edit name
& character** to visit WorldsBay and return to the same player. New Google signups
choose their public name on WorldsBay. Account deletion is also handled there,
with explicit confirmation; this starter never receives account passwords.

```sh
npm run check
```

This runs the typecheck, builds the browser modules, and tests the starter and
API integration using synthetic sessions. It needs no live account or world key. Rebuild
after changing files in `packages/`. `npm start` uses the already-built runtime.

The starter connects to the hosted WorldsBay service; it does not run a local
account server. World keys belong only in `.env`, which Git ignores along with
the registration file. Keep your reverse proxy limited to the world server;
never expose the repository as a static directory.

Public alpha: up to three worlds per saved account. Listed wardrobe items are free to claim.
Update this source and rebuild to receive runtime fixes.

## License

[MIT](LICENSE). Third-party software, font material, and character assets keep
their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
