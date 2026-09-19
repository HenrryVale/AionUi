// HTTP client for the local aioncore instance.
//
// Three calls, deliberately: read the team, read leader messages, send one team
// message. There is no `POST /api/teams` and no `POST /api/conversations` here —
// the bridge reuses the configured team and the leader's existing conversation,
// and must never be able to create either.
//
// aioncore wraps successful responses in `{ success, data }`; `unwrap` mirrors
// what `httpBridge` does on the renderer side.

import type { AioncoreClient, BridgeDeps, LeaderMessagePage, TeamRunAck, TeamSnapshot } from './types.js';

/** Team member role token the backend uses for the leader. */
const LEADER_ROLES = new Set(['lead', 'leader']);

export class AioncoreRequestError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`aioncore ${method} ${path} failed with HTTP ${status}`);
    this.name = 'AioncoreRequestError';
    this.status = status;
  }
}

function unwrap<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

/**
 * Pick the leader's conversation id out of a team snapshot.
 *
 * Returns `null` when the team has no leader or the leader has no conversation
 * yet — the caller fails closed rather than guessing a member.
 */
export function resolveLeaderConversationId(team: TeamSnapshot | undefined): string | null {
  const members = team?.assistants ?? team?.agents ?? [];
  const leader = members.find((member) => LEADER_ROLES.has((member.role ?? '').toLowerCase()));
  const conversationId = leader?.conversation_id?.trim();
  return conversationId ? conversationId : null;
}

export function createAioncoreClient(backendPort: number, deps: BridgeDeps): AioncoreClient {
  const baseUrl = `http://127.0.0.1:${backendPort}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await deps.fetch(`${baseUrl}${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new AioncoreRequestError(method, path, response.status);
    }
    return unwrap<T>(await response.json());
  }

  return {
    getTeam(teamId: string): Promise<TeamSnapshot> {
      return request<TeamSnapshot>('GET', `/api/teams/${encodeURIComponent(teamId)}`);
    },

    getLeaderMessages(conversationId: string, options: { after?: string; limit: number }) {
      const params = new URLSearchParams();
      params.set('limit', String(options.limit));
      // `after` is an OPAQUE keyset cursor (`v1...`) taken from a previous
      // page's `newest_cursor`. A message id is not a valid value here.
      if (options.after) params.set('after', options.after);
      params.set('content_mode', 'full');
      return request<LeaderMessagePage>(
        'GET',
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
      );
    },

    sendTeamMessage(teamId: string, content: string): Promise<TeamRunAck> {
      // Always enters through the leader: the team route targets `lead` server-side.
      return request<TeamRunAck>('POST', `/api/teams/${encodeURIComponent(teamId)}/messages`, { content });
    },
  };
}
