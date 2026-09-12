# Two avatar styles

Players can save one `low-poly` character and one `detailed` character. Saving replaces only that style and makes it the preferred look. Switching styles in the studio retains local drafts; save each style to keep it across visits. Reset affects only the displayed style. Existing saved characters migrate into their matching slot.

World registration and metadata updates accept `avatarSupport`: `["low-poly"]`, `["detailed"]`, `["low-poly", "detailed"]`, or `[]` for world-provided avatars. The directory displays this setting. The character studio also shows small world pictures for the currently selected style: ✓ means supported, × means the world uses another avatar, and ? means support has not been specified. Switching between low poly and detailed updates these indicators immediately. Only connected worlds are listed. Omitted metadata preserves legacy behavior and displays “Avatar support not specified”; it does not claim either style works.

The authenticated `/internal/appearance` endpoint selects the preferred character when supported, otherwise the saved compatible slot. It does not change the player's preference. Responses include `avatarStyle` and `avatarSupported`. If no supported saved character exists, the classic low-poly avatar can serve low-poly worlds. When `avatarSupported` is false (including support `[]`), games must use their own avatar and retain the supplied player identity. The shared renderer declines to load personal assets in this case and uses its existing fallback. Custom game integrations must honor this flag.

`GET /api/me` exposes `avatarSlots` keyed by style, alongside the existing preferred `characterRecipe`. `POST /api/character` remains revision-checked and infers style from the validated rig; callers cannot label a detailed rig as low poly.

For Mistborn, set `avatarSupport: ["low-poly"]` in its registry entry or world settings. This repository change does not update a remote world registration or deploy the server.

Managed worlds: Gate Room (`stargate`) defaults to both low-poly and detailed avatars; Banners & Blades (`westeros`) accepts low-poly only. Explicit Stargate registration settings remain editable.

The detailed picker temporarily hides paired dark-skin variants that currently duplicate the light-skin options. Light variants remain selectable. Existing saved recipes and source assets are retained.
