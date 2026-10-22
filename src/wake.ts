// When the ops agent wakes. Deterministic rules, no LLM gate (P6, plan §7). Pure: the core calls it
// inside append() so the wake is written in the same transaction as the event. Contract:
// docs/design/ops-agent.md.

import type { ThreadKind } from './core.ts';

export type WakeReason =
  | 'slack_dm' | 'slack_mention'
  | 'agent_message' | 'relay_request' | 'for_human' | 'ask_human'
  | 'new_window' | 'new_incident'
  | 'status_alert';

export interface WakeEvent { actor: string; type: string; body: Record<string, unknown> }
export interface WakeThread { kind: ThreadKind; visibility: string }

export function wakeReason(e: WakeEvent, t: WakeThread): WakeReason | null {
  if (e.actor === 'ops') return null; // never on its own output
  // The ops agent sees shared threads and DMs only (plan §4); a private thread can't wake it.
  if (t.visibility !== 'shared' && t.kind !== 'dm') return null;
  switch (e.type) {
    case 'message': {
      if (e.actor.startsWith('principal:')) {
        if (t.kind === 'dm') return 'slack_dm';
        if (e.body['mentions_bot'] === true) return 'slack_mention';
        // Even in a thread it spoke in: humans discuss in peace and tag it when they want it (P2).
        return null; // logged, and in the context of its next turn
      }
      // P3: an agent's words for a human (the core sets for_human, never the agent) reach the human only through the ops agent.
      if (e.actor.startsWith('agent:') && Array.isArray(e.body['for_human']) && e.body['for_human'].length > 0) return 'for_human';
      if (e.actor.startsWith('agent:') && e.body['to'] === 'ops') return 'agent_message';
      return null;
    }
    case 'relay_request': return 'relay_request';
    // P3: an agent's question for a human waits for the ops agent to present it (present_ask).
    case 'ask_human': return e.actor.startsWith('agent:') ? 'ask_human' : null;
    case 'window_requested': return 'new_window';
    case 'incident_opened': return 'new_incident';
    // An urgent window's decision, clock and report (window_decision, window_state, window_reminder, window_report)
    // only rewrite its card; the requesting agent hears from the core, and the ops agent has nothing to add (P5).
    case 'status_alert': return 'status_alert';
    default: return null;
  }
}
