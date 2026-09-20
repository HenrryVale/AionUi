import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { GetConfigOptionsResponse, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
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
  attachAgent: (teamId: string, slotId: string) => Promise<unknown>;
  getConfigOptions: (teamId: string, conversationId: string) => Promise<GetConfigOptionsResponse>;
  setConfigOption: (
    teamId: string,
    conversationId: string,
    optionId: string,
    value: string
  ) => Promise<SetConfigOptionResponse>;
  wait: (ms: number) => Promise<void>;
};

const RUNTIME_READY_POLL_MS = 250;
const RUNTIME_READY_MAX_ATTEMPTS = 80;

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
  attachAgent: (teamId, slotId) =>
    ipcBridge.team.attachAgent.invoke({ team_id: teamId, slot_id: slotId }),
  getConfigOptions: (teamId, conversationId) =>
    ipcBridge.team.getConfigOptions.invoke({ team_id: teamId, conversation_id: conversationId }),
  setConfigOption: (teamId, conversationId, optionId, value) =>
    ipcBridge.team.setConfigOption.invoke({
      team_id: teamId,
      conversation_id: conversationId,
      option_id: optionId,
      value,
    }),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function resolveModeOption(response: GetConfigOptionsResponse) {
  return response.config_options.find(
    (option) => option.category === 'mode' || option.id === 'mode'
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRuntimeConfigOptions(
  teamId: string,
  conversationId: string,
  memberName: string,
  deps: TeamRolePermissionDeps
): Promise<GetConfigOptionsResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt < RUNTIME_READY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await deps.getConfigOptions(teamId, conversationId);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < RUNTIME_READY_MAX_ATTEMPTS) {
        await deps.wait(RUNTIME_READY_POLL_MS);
      }
    }
  }

  throw new Error(
    `Role runtime did not become ready for ${memberName}: ${errorText(lastError)}`
  );
}

/**
 * AionCore intentionally starts only the Team leader and lazily attaches
 * teammates later. During that attach path it rebuilds the Team runtime in the
 * backend's full-auto mode, so a conversation.extra session_mode seed alone is
 * not sufficient for restrictive roles such as QA=plan.
 *
 * Creation therefore uses two layers:
 * 1. Seed every role's requested mode on the persisted conversation.
 * 2. For restrictive plan roles, eagerly attach the teammate, wait until the
 *    real runtime exposes config options, set mode=plan on that runtime, then
 *    re-seed conversation.extra because the attach rebuild writes full-auto
 *    there before the live mode switch.
 *
 * Once the live switch is observed, AionCore persists the ACP runtime mode in
 * acp_session; future rebuilds prefer that persisted runtime mode over the
 * create-time session_mode seed.
 */
export async function enforceTeamRolePermissionModesWithDeps(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[],
  deps: TeamRolePermissionDeps
): Promise<void> {
  if (assignments.length === 0) return;

  const resolved = assignments.map((assignment) => {
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
    return { assignment, member };
  });

  for (const { assignment, member } of resolved) {
    await deps.seedConversationMode(member.conversation_id, assignment.mode);
  }

  await deps.ensureSession(team.id);

  for (const { assignment, member } of resolved) {
    // Claude Team members already default to full-auto when the requested role
    // mode is bypassPermissions. Keep those teammates lazy. Restrictive roles
    // must be made real before the Team is exposed to work.
    if (assignment.mode !== 'plan') continue;

    if (member.role !== 'leader') {
      await deps.attachAgent(team.id, member.slot_id);
    }

    const options = await waitForRuntimeConfigOptions(
      team.id,
      member.conversation_id,
      assignment.assistantName,
      deps
    );
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

    // The eager Team attach writes the backend full-auto seed before the live
    // switch. Restore the intended persisted seed so diagnostics and any
    // fallback rebuild path agree with the runtime policy.
    await deps.seedConversationMode(member.conversation_id, assignment.mode);
  }
}

export async function enforceTeamRolePermissionModes(
  team: TTeam,
  assignments: TeamRolePermissionAssignment[]
): Promise<void> {
  return enforceTeamRolePermissionModesWithDeps(team, assignments, liveDeps);
}
