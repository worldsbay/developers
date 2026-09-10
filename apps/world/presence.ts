import { WORLD_CONNECTING_MS } from '../../packages/wire/presence.js';

/** Only new entry attempts get a loading lease; stored login cookies are not presence. */
export class ConnectingPlayers {
  private pending = new Map<string, number>();
  constructor(private now: () => number) {}
  begin(grant: string) {
    this.pending.set(grant, this.now() + WORLD_CONNECTING_MS);
  }
  finish(grant: string) {
    this.pending.delete(grant);
  }
  count(
    activeGrants: string[],
    sessions: { grant: string; expires: number; appearance?: { player: { id: string } } }[],
  ) {
    const byGrant = new Map(sessions.map((session) => [session.grant, session]));
    const identity = (grant: string) => byGrant.get(grant)?.appearance?.player.id ?? grant;
    const connected = new Set(activeGrants.map(identity));
    const connecting = new Set<string>();
    for (const [grant, until] of this.pending) {
      const session = byGrant.get(grant);
      if (
        !session ||
        session.expires <= this.now() ||
        until <= this.now() ||
        connected.has(identity(grant))
      ) {
        this.pending.delete(grant);
      } else connecting.add(identity(grant));
    }
    return { connectedPlayers: connected.size, connectingPlayers: connecting.size };
  }
}
