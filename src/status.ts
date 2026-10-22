// A status source: your system's own read-only status (health, what is running, open alerts, events) for the ops
// agent. Optional. The only implementation here is a stub that says nothing is connected; plug a real one in behind
// the same interface (docs/design/status.md). Switchboard relays and routes what it sees; it never acts on it (P1).

export interface StatusSource {
  health(): Promise<unknown>;
  live(): Promise<unknown>;
  overview(): Promise<unknown>;
  events(query: { since?: string | undefined; kind?: string | undefined; run?: string | undefined; limit?: number | undefined }): Promise<unknown>;
}

const UNAVAILABLE = {
  available: false,
  reason: 'No status source is connected (docs/design/status.md). Say you can\'t see the system\'s status; don\'t guess it.',
};

export class StubStatus implements StatusSource {
  async health() { return UNAVAILABLE; }
  async live() { return UNAVAILABLE; }
  async overview() { return UNAVAILABLE; }
  async events() { return UNAVAILABLE; }
}
