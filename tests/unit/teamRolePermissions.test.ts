import { describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';
import {
  enforceTeamRolePermissionModesWithDeps,
  type TeamRolePermissionAssignment,
} from '@/renderer/pages/team/components/memberPicker/teamRolePermissions';

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

describe('team role permission enforcement', () => {
  it('does nothing when no specialized role assignments exist', async () => {
    const ensureSession = vi.fn(async () => undefined);

    await enforceTeamRolePermissionModesWithDeps(
      team,
      [],
      {
        ensureSession,
        getConfigOptions: vi.fn(),
        setConfigOption: vi.fn(),
      }
    );

    expect(ensureSession).not.toHaveBeenCalled();
  });

  it('warms the team and applies the required mode to the matching member conversation', async () => {
    const ensureSession = vi.fn(async () => undefined);
    const getConfigOptions = vi.fn(async () => configOptions);
    const setConfigOption = vi.fn(async () => ({
      confirmation: 'observed' as const,
      config_options: configOptions.config_options,
    }));

    await enforceTeamRolePermissionModesWithDeps(
      team,
      [qaAssignment],
      { ensureSession, getConfigOptions, setConfigOption }
    );

    expect(ensureSession).toHaveBeenCalledOnce();
    expect(getConfigOptions).toHaveBeenCalledWith('team-1', 'conv-qa');
    expect(setConfigOption).toHaveBeenCalledWith('team-1', 'conv-qa', 'mode', 'plan');
  });

  it('fails closed when the required role member cannot be resolved', async () => {
    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [{ ...qaAssignment, assistantName: 'Claude QA Missing' }],
        {
          ensureSession: vi.fn(async () => undefined),
          getConfigOptions: vi.fn(),
          setConfigOption: vi.fn(),
        }
      )
    ).rejects.toThrow('Role member not found');
  });

  it('fails closed when the runtime does not advertise the required permission mode', async () => {
    const unsupported = {
      config_options: [
        {
          ...configOptions.config_options[0],
          options: [{ value: 'default', label: 'Default' }],
        },
      ],
    };

    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [qaAssignment],
        {
          ensureSession: vi.fn(async () => undefined),
          getConfigOptions: vi.fn(async () => unsupported),
          setConfigOption: vi.fn(),
        }
      )
    ).rejects.toThrow('Required permission mode "plan" is unavailable');
  });

  it('fails closed when the runtime exposes no mode option', async () => {
    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [qaAssignment],
        {
          ensureSession: vi.fn(async () => undefined),
          getConfigOptions: vi.fn(async () => ({ config_options: [] })),
          setConfigOption: vi.fn(),
        }
      )
    ).rejects.toThrow('Permission mode option is unavailable');
  });
});
