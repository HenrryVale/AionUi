import { ipcBridge } from '@/common';
import type { GetConfigOptionsResponse, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { TeamRolePermissionMode } from './teamRoleProfiles';

export type TeamRolePermissionAssignment = {
  assistantId: string;
  assistantName: string;
  mode: TeamRolePermissionMode;
};

export type TeamRolePermissionDeps = {
  ensureSession: (teamId: string) => Promise<unknown>;
  getConfigOptions: (teamId: string, conversationId: string) => Promise<GetConfigOptionsResponse>;
  setConfigOption: (
    teamId: string,
    conversationId: string,
    optionId: string,
    value: string
  ) => Promise<SetConfigOptionResponse>;
};

const liveDeps: TeamRolePermissionDeps = {
  ensureSession: (teamId) => ipcBridge.team.ensureSession.invoke({ team_id: teamId }),
  getConfigOptions: (teamId, conversationId) =>
    ipcBridge.team.getConfigOptions.invoke({ team_id: teamId, conversation_id: conversationId }),
  setConfigOption: (teamId, conversationId, optionId, value) =>
    ipcBridge.team.setConfigOption.invoke({
      team_id: teamId,
      conversation_id: conversationId,
      option_id: optionId,
      value,
    }),
};

function resolveModeOption(response: GetConfigOptionsResponse) {
  return response.config_options.find(
    (option) => option.category === 'mode' || option.id === 'mode'
  );
}

export async function enforceTeamRolePermissionModesWithDeps(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[],
  deps: TeamRolePermissionDeps
): Promise<void> {
  if (assignments.length === 0) return;

  await deps.ensureSession(team.id);

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

    const options = await deps.getConfigOptions(team.id, member.conversation_id);
    const modeOption = resolveModeOption(options);
    if (!modeOption) {
      throw new Error(
        `Permission mode option is unavailable for role member: ${assignment.assistantName}`
      );
    }

    const availableModes = new Set(modeOption.options.map((option) => option.value));
    if (!availableModes.has(assignment.mode)) {
      throw new Error(
        `Required permission mode "${assignment.mode}" is unavailable for ${assignment.assistantName}`
      );
    }

    await deps.setConfigOption(
      team.id,
      member.conversation_id,
      modeOption.id,
      assignment.mode
    );
  }
}

export async function enforceTeamRolePermissionModes(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[]
): Promise<void> {
  return enforceTeamRolePermissionModesWithDeps(team, assignments, liveDeps);
}
