import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import type { TeamAssistant } from '@/common/types/team/teamTypes';
import type { ensureTeamRoleAssistant } from './teamRoleProfiles';
import { parseTeamRoleAssistantId, TEAM_ROLE_PROFILES } from './teamRoleProfiles';
import type { enforceTeamRolePermissionModeForMember } from './teamRolePermissions';

export type AddTeamAssistantRolePolicyDeps = {
  ensureRoleAssistant: typeof ensureTeamRoleAssistant;
  addAgent: (assistant: TeamAssistantInput) => Promise<TeamAssistant>;
  enforceRoleMode: typeof enforceTeamRolePermissionModeForMember;
  resolveRoleModel: (assistantId: string) => Promise<string>;
  removeAgent: (slotId: string) => Promise<unknown>;
  mutateTeam: () => Promise<unknown>;
};

export async function addTeamAssistantWithRolePolicy(
  teamId: string,
  assistant: TeamAssistantInput,
  deps: AddTeamAssistantRolePolicyDeps
): Promise<TeamAssistant> {
  const roleIdentity = parseTeamRoleAssistantId(assistant.assistant_id);
  let resolvedAssistant = assistant;

  if (roleIdentity) {
    // Reconcile generated role assistants at the point of use. This repairs
    // persisted pre-marker profiles after an image upgrade and reasserts the
    // pinned skill catalog before a new Team member references the assistant.
    const roleAssistant = await deps.ensureRoleAssistant(roleIdentity);
    resolvedAssistant = {
      ...assistant,
      assistant_id: roleAssistant.id,
      // Re-resolve after provisioning. A persisted role profile can have stale
      // model defaults even when its generated assistant id is unchanged.
      model: await deps.resolveRoleModel(roleAssistant.id),
    };
  }

  const created = await deps.addAgent(resolvedAssistant);

  if (roleIdentity) {
    try {
      await deps.enforceRoleMode(teamId, created, {
        assistantId: resolvedAssistant.assistant_id,
        assistantName: created.assistant_name,
        mode: TEAM_ROLE_PROFILES[roleIdentity.specialty].permissionMode,
      });
    } catch (error) {
      // Never leave a role member attached with a weaker/incorrect runtime
      // mode when post-add policy enforcement fails.
      try {
        await deps.removeAgent(created.slot_id);
      } catch (rollbackError) {
        console.error(
          '[TeamRoleMemberLifecycle] Failed to roll back role member after permission error:',
          rollbackError
        );
      }
      await deps.mutateTeam();
      throw error;
    }
  }

  await deps.mutateTeam();
  return created;
}
