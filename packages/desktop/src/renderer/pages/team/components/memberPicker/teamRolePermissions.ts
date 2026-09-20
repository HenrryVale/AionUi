import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { TeamRolePermissionMode } from './teamRoleProfiles';

export type TeamRolePermissionAssignment = {
  assistantId: string;
  assistantName: string;
  mode: TeamRolePermissionMode;
};

export type TeamRolePermissionDeps = {
  seedConversationMode: (conversationId: string, mode: TeamRolePermissionMode) => Promise<unknown>;
  ensureSession: (teamId: string) => Promise<unknown>;
};

const liveDeps: TeamRolePermissionDeps = {
  seedConversationMode: (conversationId, mode) =>
    ipcBridge.conversation.update.invoke({
      id: conversationId,
      updates: {
        extra: { session_mode: mode } as TChatConversation['extra'],
      } as Partial<TChatConversation>,
      merge_extra: true,
    }),
  ensureSession: (teamId) => ipcBridge.team.ensureSession.invoke({ team_id: teamId }),
};

/**
 * Team creation persists every member conversation before any runtime must be
 * started. Seed the role-specific permission mode into conversation.extra
 * first, then start the Team session.
 *
 * This ordering is load-bearing: AionCore intentionally warms only the leader
 * on initial Team startup; teammates stay dormant until work arrives. Trying to
 * call config-options for a dormant teammate returns TEAM_RUNTIME_NOT_READY.
 * The persisted session_mode is the value AionCore consumes when that member is
 * lazily attached later, so no eager teammate wakeup is required.
 */
export async function enforceTeamRolePermissionModesWithDeps(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[],
  deps: TeamRolePermissionDeps
): Promise<void> {
  for (const assignment of assignments) {
    const member = team.assistants.find(
      (assistant) =>
        assistant.assistant_id === assignment.assistantId &&
        assistant.assistant_name === assignment.assistantName
    );
    if (!member) {
      throw new Error(
        `Role member not found after team creation: ${assignment.assistantName} (${assignment.assistantId})`
      );
    }

    await deps.seedConversationMode(member.conversation_id, assignment.mode);
  }

  if (assignments.length > 0) {
    await deps.ensureSession(team.id);
  }
}

export async function enforceTeamRolePermissionModes(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[]
): Promise<void> {
  return enforceTeamRolePermissionModesWithDeps(team, assignments, liveDeps);
}
