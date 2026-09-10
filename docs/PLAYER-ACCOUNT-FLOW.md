# Player names, accounts, and character editing

WorldsBay owns a player's public name, character, and saved identity. Games own
their campaign or other progress, keyed by the stable player ID. Changing a name
or outfit must never create a new player or reset a campaign.

## Signing up and signing in

Google, Discord, and GitHub authenticate on the account provider's page. When the
provider is new to WorldsBay, the central account page then asks **What should we
call you?** The player chooses a public display name and sees which game they will
return to. The provider's real name is not automatically made public. Names use
the shared 2–24 character validation and can be changed later.

This step also applies when a new provider account starts from **Sign in**. If the
flow has a bound guest, creating the account preserves that guest's character and
progress. Existing accounts skip name setup and restore their saved identity;
they do not inherit a different guest's name, character, or campaign. Email signup
already collects a display name before confirmation.

The account is saved and a fresh game return code is issued after name setup.
An unfinished setup expires with the browser-bound account flow; it does not
silently complete signup. Show errors and allow another sign-in attempt.
Passwords and provider tokens never pass through a game's frontend or server.

## The in-game account menu

| Player state               | Controls and explanation                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest                      | **Create account**, **Sign in**, **Edit name & character**. Explain that saving an account keeps this character and progress across devices.  |
| Email confirmation pending | Show that confirmation is pending and retain guest controls. Continuing play uses the same guest.                                             |
| Saved account              | **Edit name & character**, **Use another account**, **Sign out**. Show the public name and that progress is saved. Hide guest-saving prompts. |

Use `await sdk.readAccount()` to determine the state; a generated-looking name
does not prove that the player is a guest. Previously saved accounts can still
have names such as Sunny Robin 5629. Let those players edit their name without
forcing another signup or replacing their identity.

**Continue campaign** simply closes a game's menu. **Sign out** acts on the first
click, displays progress, and returns to entry after success. It clears this
world's session and remembered identity; the saved account, campaign, and central
website login remain intact. A failed logout keeps the game available for retry.

## Open the editor and return to the game

Label the action **Edit name & character** and explain: “Opens WorldsBay in this
tab. Change your name, avatar or outfit, then choose Return to [world name] to
resume playing.” Use the current world's actual name in that explanation.

```js
// sdk is a WorldsBay client on your world's origin.
// These callbacks use your game's own input, connection and error UI.
async function editCharacter(button) {
  if (button.disabled) return;
  button.disabled = true;
  clearHeldMovement();
  stopPlayerMovement();
  try {
    const { url } = await sdk.openCharacterCreator();
    stopRoomReconnects();
    disconnectRoom();
    window.location.assign(url);
  } catch (error) {
    button.disabled = false;
    showError(error.message);
  }
}
```

`openCharacterCreator()` uses the authenticated `/api/store` bridge and returns a
central editor URL with the game return context. It does not navigate by itself.
Use that URL rather than a plain link to `/play?view=character`, which loses the
world identity handoff and return context. The example callbacks above are game
integration points, not SDK methods. Keep the connection usable on a failed
handoff, and prevent overlapping account/navigation actions in your implementation.

In the editor, **Edit name → Save name** saves the public name. Appearance changes
remain a preview until **Save character**. **Return to [world name]** restores the
same player in the game with the saved name and appearance. Read the returned
session and canonical appearance again; never start a guest merely because the
player left to edit. Keep game progress keyed by player ID, not display name.

The shared hub/Observatory runtime and Gate Room use this handoff. Banners & Blades
uses the same SDK method from its campaign account menu. Browser tests cover Google
signup, naming, failed editor requests, changing name and outfit, and returning to
the same captain, house, and troops.

## Deleting a player account

On WorldsBay, open the account's **Account options → Delete account**. The dialog
names the current player, explains permanent loss, and requires typing `DELETE`.
Cancel is focused first. Guests do not see this action. Games should route players
to WorldsBay through the editor/account handoff above rather than implement their
own deletion API or collect sign-in credentials.

Central binds a five-minute, single-use confirmation to both the player and the
current browser session. Only a same-origin request can confirm it. Deletion
removes the player profile, character, wardrobe, local orders/travel history and
all central, world, resume, store and return credentials in one SQLite transaction.
Other players are unaffected. Registered world/group owners must arrange ownership
transfer with WorldsBay first; deleting a player never silently deletes a world.

Account closure and local data removal do not require a Supabase admin key.
Google/email sign-in records are marked for permanent deletion, and the completion
screen explicitly says that cleanup is pending. Central's optional private
`SUPABASE_SECRET_KEY` enables automated remote cleanup, which retries after
temporary failure and process restart. A minimal hashed identity tombstone blocks
outstanding provider callbacks from recreating the old account; the raw provider
subject is removed after cleanup succeeds. Google/Discord/GitHub accounts themselves
are unaffected. Backup copies expire through backup retention; after restoring a
backup operators must reapply deletions before reopening access. Independent games
retain responsibility for their own data deletion and should explain how players
can contact them. Never promise their campaign data was physically erased by central.

## Updating an installed starter

The npm API methods are unchanged. Rebuild the game UI and distribute the updated
starter/runtime as well as the central account service. Existing world installations
do not update themselves. Older adapters need the authenticated account and store
bridge routes described in [the integration contract](ARCHITECTURE.md); adding a
button alone is not enough. Keep the developers repository and deployed examples in sync, and test the full
journey before publishing changes.
