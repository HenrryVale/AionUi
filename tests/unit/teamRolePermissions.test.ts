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

describe('team role permission enforcement', () => {
  it('does nothing when no specialized role assignments exist', async () => {
    const seedConversationMode = vi.fn(async () => undefined);
    const ensureSession = vi.fn(async () => undefined);

    await enforceTeamRolePermissionModesWithDeps(
      team,
      [],
      { seedConversationMode, ensureSession }
    );

    expect(seedConversationMode).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it('seeds the role mode before starting the team session', async () => {
    const calls: string[] = [];
    const seedConversationMode = vi.fn(async (conversationId: string, mode: string) => {
      calls.push(`seed:${conversationId}:${mode}`);
    });
    const ensureSession = vi.fn(async (teamId: string) => {
      calls.push(`ensure:${teamId}`);
    });

    await enforceTeamRolePermissionModesWithDeps(
      team,
      [qaAssignment],
      { seedConversationMode, ensureSession }
    );

    expect(seedConversationMode).toHaveBeenCalledWith('conv-qa', 'plan');
    expect(ensureSession).toHaveBeenCalledWith('team-1');
    expect(calls).toEqual(['seed:conv-qa:plan', 'ensure:team-1']);
  });

  it('seeds every specialized member before starting the team session', async () => {
    const calls: string[] = [];
    const seedConversationMode = vi.fn(async (conversationId: string, mode: string) => {
      calls.push(`seed:${conversationId}:${mode}`);
    });
    const ensureSession = vi.fn(async () => {
      calls.push('ensure');
    });

    await enforceTeamRolePermissionModesWithDeps(
      team,
      [
        {
          assistantId: 'team-role:bare:claude:pm',
          assistantName: 'Claude PM',
          mode: 'bypassPermissions',
        },
        qaAssignment,
      ],
      { seedConversationMode, ensureSession }
    );

    expect(calls).toEqual([
      'seed:conv-pm:bypassPermissions',
      'seed:conv-qa:plan',
      'ensure',
    ]);
  });

  it('fails closed when the required role member cannot be resolved', async () => {
    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [{ ...qaAssignment, assistantName: 'Claude QA Missing' }],
        {
          seedConversationMode: vi.fn(async () => undefined),
          ensureSession: vi.fn(async () => undefined),
        }
      )
    ).rejects.toThrow('Role member not found');
  });

  it('does not start the team if seeding a role mode fails', async () => {
    const ensureSession = vi.fn(async () => undefined);

    await expect(
      enforceTeamRolePermissionModesWithDeps(
        team,
        [qaAssignment],
        {
          seedConversationMode: vi.fn(async () => {
            throw new Error('seed failed');
          }),
          ensureSession,
        }
      )
    ).rejects.toThrow('seed failed');

    expect(ensureSession).not.toHaveBeenCalled();
  });
});
