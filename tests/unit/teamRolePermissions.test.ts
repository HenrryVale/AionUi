import { describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';
import {
  enforceTeamRolePermissionModeForMemberWithDeps,
  enforceTeamRolePermissionModesWithDeps,
  type TeamRolePermissionAssignment,
  type TeamRolePermissionDeps,
} from '@/renderer/pages/team/components/memberPicker/teamRolePermissions';
import { addTeamAssistantWithRolePolicy } from '@/renderer/pages/team/hooks/useTeamSession';

const team: TTeam = {
  id: 'team-1',
  user_id: 'user-1',
  name: 'Claude delivery team',
  workspace: '/workspace/project',
  workspace_mode: 'shared',
  leader_assistant_id: 'slot-pm',
  assistants: [
    {
      slot_id: 'slot-pm',
      conversation_id: 'conv-pm',
      role: 'leader',
      assistant_backend: 'claude',
      assistant_name: 'Claude PM',
      assistant_id: 'team-role:bare:claude:pm',
      status: 'idle',
      context_reset: { supported: false, availability: 'unsupported' },
    },
    {
      slot_id: 'slot-qa',
      conversation_id: 'conv-qa',
      role: 'teammate',
      assistant_backend: 'claude',
      assistant_name: 'Claude QA',
      assistant_id: 'team-role:bare:claude:qa',
      status: 'idle',
      context_reset: { supported: false, availability: 'unsupported' },
    },
  ],
  created_at: 1,
  updated_at: 1,
};

const qaAssignment: TeamRolePermissionAssignment = {
  assistantId: 'team-role:bare:claude:qa',
  assistantName: 'Claude QA',
  mode: 'plan',
};

const pmAssignment: TeamRolePermissionAssignment = {
  assistantId: 'team-role:bare:claude:pm',
  assistantName: 'Claude PM',
  mode: 'bypassPermissions',
};

const configOptions = {
  config_options: [
    {
      id: 'mode',
      category: 'mode',
      type: 'select' as const,
      current_value: 'bypassPermissions',
      options: [
        { value: 'default', label: 'Default' },
        { value: 'plan', label: 'Plan Mode' },
        { value: 'bypassPermissions', label: 'Bypass Permissions' },
      ],
    },
  ],
};

function deps(overrides: Partial<TeamRolePermissionDeps> = {}): TeamRolePermissionDeps {
  return {
    seedConversationMode: vi.fn(async () => undefined),
    ensureSession: vi.fn(async () => undefined),
    attachAgent: vi.fn(async () => undefined),
    getConfigOptions: vi.fn(async () => configOptions),
    setConfigOption: vi.fn(async () => ({
      confirmation: 'observed' as const,
      config_options: configOptions.config_options,
    })),
    wait: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('team role permission enforcement', () => {
  it('does nothing when no specialized role assignments exist', async () => {
    const d = deps();

    await enforceTeamRolePermissionModesWithDeps(team, [], d);

    expect(d.seedConversationMode).not.toHaveBeenCalled();
    expect(d.ensureSession).not.toHaveBeenCalled();
    expect(d.attachAgent).not.toHaveBeenCalled();
  });

  it('eagerly attaches a restrictive teammate and applies plan to the live runtime', async () => {
    const calls: string[] = [];
    const d = deps({
      seedConversationMode: vi.fn(async (conversationId: string, mode: string) => {
        calls.push(`seed:${conversationId}:${mode}`);
      }),
      ensureSession: vi.fn(async (teamId: string) => {
        calls.push(`ensure:${teamId}`);
      }),
      attachAgent: vi.fn(async (teamId: string, slotId: string) => {
        calls.push(`attach:${teamId}:${slotId}`);
      }),
      getConfigOptions: vi.fn(async (teamId: string, conversationId: string) => {
        calls.push(`options:${teamId}:${conversationId}`);
        return configOptions;
      }),
      setConfigOption: vi.fn(async (teamId, conversationId, optionId, value) => {
        calls.push(`set:${teamId}:${conversationId}:${optionId}:${value}`);
        return {
          confirmation: 'observed' as const,
          config_options: configOptions.config_options,
        };
      }),
    });

    await enforceTeamRolePermissionModesWithDeps(team, [qaAssignment], d);

    expect(calls).toEqual([
      'seed:conv-qa:plan',
      'ensure:team-1',
      'attach:team-1:slot-qa',
      'options:team-1:conv-qa',
      'set:team-1:conv-qa:mode:plan',
      'seed:conv-qa:plan',
    ]);
  });

  it('enforces the same restrictive policy for one member added to an existing team', async () => {
    const d = deps();
    const member = team.assistants.find((assistant) => assistant.slot_id === 'slot-qa')!;

    await enforceTeamRolePermissionModeForMemberWithDeps('team-1', member, qaAssignment, d);

    expect(d.seedConversationMode).toHaveBeenCalledWith('conv-qa', 'plan');
    expect(d.ensureSession).toHaveBeenCalledWith('team-1');
    expect(d.attachAgent).toHaveBeenCalledWith('team-1', 'slot-qa');
    expect(d.setConfigOption).toHaveBeenCalledWith('team-1', 'conv-qa', 'mode', 'plan');
  });

  it('keeps full-auto teammates lazy', async () => {
    const d = deps();

    await enforceTeamRolePermissionModesWithDeps(team, [pmAssignment], d);

    expect(d.seedConversationMode).toHaveBeenCalledWith('conv-pm', 'bypassPermissions');
    expect(d.ensureSession).toHaveBeenCalledWith('team-1');
    expect(d.attachAgent).not.toHaveBeenCalled();
    expect(d.getConfigOptions).not.toHaveBeenCalled();
    expect(d.setConfigOption).not.toHaveBeenCalled();
  });

  it('waits for a restrictive teammate runtime to become ready', async () => {
    let attempts = 0;
    const getConfigOptions = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('TEAM_RUNTIME_NOT_READY');
      return configOptions;
    });
    const wait = vi.fn(async () => undefined);
    const d = deps({ getConfigOptions, wait });

    await enforceTeamRolePermissionModesWithDeps(team, [qaAssignment], d);

    expect(getConfigOptions).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(d.setConfigOption).toHaveBeenCalledWith('team-1', 'conv-qa', 'mode', 'plan');
  });

  it('fails closed when the runtime does not advertise the required mode', async () => {
    const unsupported = {
      config_options: [
        {
          ...configOptions.config_options[0],
          options: [{ value: 'bypassPermissions', label: 'Bypass Permissions' }],
        },
      ],
    };
    const d = deps({
      getConfigOptions: vi.fn(async () => unsupported),
    });

    await expect(
      enforceTeamRolePermissionModesWithDeps(team, [qaAssignment], d)
    ).rejects.toThrow('Required permission mode "plan" is unavailable');

    expect(d.setConfigOption).not.toHaveBeenCalled();
  });

  it('fails closed when the required role member cannot be resolved', async () => {
    const d = deps();

    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [{ ...qaAssignment, assistantName: 'Claude QA Missing' }],
        d
      )
    ).rejects.toThrow('Role member not found');

    expect(d.seedConversationMode).not.toHaveBeenCalled();
    expect(d.ensureSession).not.toHaveBeenCalled();
  });

  it('re-provisions and enforces a generated role when adding it to an existing team', async () => {
    const created = team.assistants.find((assistant) => assistant.slot_id === 'slot-qa')!;
    const ensureRoleAssistant = vi.fn(async () => ({ id: 'team-role:bare:claude:qa' }) as never);
    const addAgent = vi.fn(async () => created);
    const enforceRoleMode = vi.fn(async () => undefined);
    const removeAgent = vi.fn(async () => undefined);
    const mutateTeam = vi.fn(async () => undefined);

    const result = await addTeamAssistantWithRolePolicy(
      'team-1',
      {
        role: 'teammate',
        assistant_name: 'Claude QA',
        assistant_id: 'team-role:bare:claude:qa',
        model: 'claude-sonnet',
      },
      {
        ensureRoleAssistant,
        addAgent,
        enforceRoleMode,
        removeAgent,
        mutateTeam,
      }
    );

    expect(result).toBe(created);
    expect(ensureRoleAssistant).toHaveBeenCalledWith({
      baseAssistantId: 'bare:claude',
      specialty: 'qa',
    });
    expect(addAgent).toHaveBeenCalledWith(
      expect.objectContaining({ assistant_id: 'team-role:bare:claude:qa' })
    );
    expect(enforceRoleMode).toHaveBeenCalledWith(
      'team-1',
      created,
      expect.objectContaining({
        assistantId: 'team-role:bare:claude:qa',
        assistantName: 'Claude QA',
        mode: 'plan',
      })
    );
    expect(removeAgent).not.toHaveBeenCalled();
    expect(mutateTeam).toHaveBeenCalledTimes(1);
  });

  it('rolls back a newly added role member when runtime permission enforcement fails', async () => {
    const created = team.assistants.find((assistant) => assistant.slot_id === 'slot-qa')!;
    const ensureRoleAssistant = vi.fn(async () => ({ id: 'team-role:bare:claude:qa' }) as never);
    const addAgent = vi.fn(async () => created);
    const enforceRoleMode = vi.fn(async () => {
      throw new Error('plan mode unavailable');
    });
    const removeAgent = vi.fn(async () => undefined);
    const mutateTeam = vi.fn(async () => undefined);

    await expect(
      addTeamAssistantWithRolePolicy(
        'team-1',
        {
          role: 'teammate',
          assistant_name: 'Claude QA',
          assistant_id: 'team-role:bare:claude:qa',
          model: 'claude-sonnet',
        },
        {
          ensureRoleAssistant,
          addAgent,
          enforceRoleMode,
          removeAgent,
          mutateTeam,
        }
      )
    ).rejects.toThrow('plan mode unavailable');

    expect(removeAgent).toHaveBeenCalledWith('slot-qa');
    expect(mutateTeam).toHaveBeenCalledTimes(1);
  });

  it('does not start the team if seeding a role mode fails', async () => {
    const ensureSession = vi.fn(async () => undefined);
    const d = deps({
      seedConversationMode: vi.fn(async () => {
        throw new Error('seed failed');
      }),
      ensureSession,
    });

    await expect(
      enforceTeamRolePermissionModesWithDeps(team, [qaAssignment], d)
    ).rejects.toThrow('seed failed');

    expect(ensureSession).not.toHaveBeenCalled();
  });
});
