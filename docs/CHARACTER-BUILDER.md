# Player characters

Players edit and save their character on WorldsBay. Your world receives their approved appearance when they enter, and the room retains that appearance while they stay connected. A game with a wardrobe can explicitly call `sdk.refreshAppearance()` to fetch and distribute a newer revision; there is no periodic appearance query. Account writes and ownership remain on the central service.

## Open the editor

Label the game action **Edit name & character**. Open the URL from
`sdk.openCharacterCreator()` in the same tab. The central editor offers **Edit name
→ Save name**, **Save character**, and **Return to [world name]**. Keep progress keyed
by player ID so changing the public name or outfit does not reset the game.
See [the player account flow](PLAYER-ACCOUNT-FLOW.md) for the complete integration.

```js
import { WorldsBay } from '/client/runtime/sdk.js';

const sdk = new WorldsBay();
async function editCharacter() {
  const { url } = await sdk.openCharacterCreator();
  location.assign(url);
}
```

Call this from your UI. It creates a player-bound central context with a return path to your world. The included world UI already provides this action. A world key does not authorize central character writes.

## Render a saved look

`startWorld()` handles classic and modular characters automatically. In another Three.js scene, use the common avatar loader so both profiles work:

```js
import { WorldsBay } from '/client/runtime/sdk.js';
import { loadAvatar } from '/client/runtime/three.js';

const { appearance } = await new WorldsBay().enterSession();
const avatar = await loadAvatar(appearance);
scene.add(avatar.root); // Your existing Three.js scene.

// In your animation loop, using your player's current locomotion:
// avatar.update(deltaSeconds, 'walk');
// When removing the character:
// avatar.dispose();
```

The optional `/client/runtime/character.js` entry exports `loadCharacterAvatar`, `composeCharacter`, `resolveCharacterPack`, `mountCharacterCreator` and the character contract. `loadCharacterAvatar()` requires an appearance containing a modular `character` recipe; use `loadAvatar()` when you may receive either profile.

The editor component is a reusable UI, not a ready-made world-side account editor. Its host must supply an approved pack, assets and a save callback. This repository provides no central account endpoints or public character-upload service.

## Assets and animation

This repository contains character source code but no full character binary library or standalone character npm package. The world server fetches the rig, selected parts and core animation assets admitted by authorized appearances, checks their SHA-256 hashes and serves them from `/avatar-assets/`. Initial loads therefore need access to WorldsBay.

The proxy serves assets needed by accepted appearances. For the full public modular catalogue, thumbnails or optional clips, the API package also provides `AssetClient`:

```js
import { AssetClient } from '@worldsbay/api/assets';

const assets = new AssetClient(); // https://assets.worldsbay.com
const pack = await assets.getCharacterPack();
// Load pack assets with your renderer as needed; this fetch loads metadata only.
// For a saved modular appearance, preserve its revision:
const savedPack = await assets.getCharacterPack({ revision: appearance.character.recipe.packRevision });
```

Use the saved-revision example only for an appearance with a modular `character`.
`assets.resolveCharacter(appearance.character)` maps its asset references to the public CDN.
This is an optional integration for custom renderers; the starter continues to use its verified world proxy.
If loading CDN assets in your own browser integration, allow `https://assets.worldsbay.com` in your
page's `connect-src` content security policy. Public asset availability does not authorize account
or wardrobe changes. Legacy v1 assets continue to use the world proxy.

The built-in room synchronizes `idle`, `walk`, `run`, `jump`, `fall`, `land`, `wave` and `dance`. Extra animation playback is presentation only unless your game's server protocol also defines the action and its timing. Held items are visual props without automatic weapon behavior.

Modular recipes pin a pack revision and select approved IDs, rig and colors. Their compatibility rules include required base parts, slot restrictions and hidden parts. Matching bone names alone does not establish that two outfits fit. Preserve these rules when writing a custom renderer; see [rig profiles](RIG-PROFILE.md) and the [character contract](../packages/character/contract.ts).

Use immutable revisions for caching, ignore stale appearance loads and dispose per-avatar resources when actors leave. Preserve attribution and license metadata when redistributing asset bytes; software and character assets may have different licenses.

[Back to the README](../README.md)
