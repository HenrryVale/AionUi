import { describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { SkillInfo } from '@/renderer/pages/settings/AssistantSettings/types';
import {
  provisionTeamRoleAssistant,
  resolveTeamRoleSkills,
  teamRoleAssistantId,
  TEAM_ROLE_PROFILES,
} from '@/renderer/pages/team/components/memberPicker/teamRoleProfiles';

const baseAssistant: Assistant = {
  id: 'bare:claude',
  source: 'generated',
  name: 'Claude',
  name_i18n: {},
  description_i18n: {},
  enabled: true,
  sort_order: 0,
  agent_id: 'claude-agent',
  enabled_skills: [],
  custom_skill_names: [],
  disabled_builtin_skills: [],
  context_i18n: {},
  prompts: [],
  prompts_i18n: {},
  models: [],
  agent_status: 'online',
  team_selectable: true,
  deletable: false,
};

const baseDetail = {
  id: 'bare:claude',
  source: 'generated' as const,
  agent_status: 'online' as const,
  team_selectable: true,
  deletable: false,
  profile: { name: 'Claude', name_i18n: {}, description_i18n: {} },
  state: { enabled: true, sort_order: 0 },
  engine: { agent_id: 'claude-agent' },
  rules: { content: '', storage_mode: 'db' },
  prompts: { recommended: [], recommended_i18n: {} },
  defaults: {
    model: { mode: 'fixed', value: 'claude-sonnet' },
    permission: { mode: 'fixed', value: 'yolo' },
    thought_level: { mode: 'auto' },
    skills: { mode: 'fixed', value: [] },
    mcps: { mode: 'auto', value: [] },
  },
  capabilities: {
    default_skill_ids: [],
    custom_skill_names: [],
    default_disabled_builtin_skill_ids: [],
  },
  preferences: {
    last_skill_ids: [],
    last_disabled_builtin_skill_ids: [],
    last_mcp_ids: [],
  },
};

const skills: SkillInfo[] = [
  {
    name: 'architecture',
    description: 'System architecture and design guidance',
    location: '/skills/architecture',
    is_auto_inject: false,
    is_custom: false,
    source: 'builtin',
  },
  {
    name: 'testing',
    description: 'Testing, regression and test design',
    location: '/skills/testing',
    is_auto_inject: false,
    is_custom: false,
    source: 'builtin',
  },
  {
    name: 'security-review',
    description: 'Security audit and vulnerability review',
    location: '/skills/security-review',
    is_auto_inject: false,
    is_custom: false,
    source: 'builtin',
  },
];

describe('team role profiles', () => {
  it('uses deterministic reusable assistant ids', () => {
    expect(teamRoleAssistantId('bare:claude', 'qa')).toBe('team-role:bare:claude:qa');
  });

  it('selects only real catalog skills relevant to a role', () => {
    expect(resolveTeamRoleSkills('qa', skills).map((skill) => skill.name)).toEqual(['testing']);
    expect(resolveTeamRoleSkills('security', skills).map((skill) => skill.name)).toEqual(['security-review']);
  });

  it('does not explicitly select builtin skills that are already auto-injected', () => {
    const autoTesting: SkillInfo = { ...skills[1], name: 'testing-auto', is_auto_inject: true };
    expect(resolveTeamRoleSkills('qa', [autoTesting]).map((skill) => skill.name)).toEqual([]);
  });

  it('inherits base assistant skills and adds role-specific skills', async () => {
    const detailWithBaseSkill = {
      ...baseDetail,
      capabilities: {
        ...baseDetail.capabilities,
        default_skill_ids: ['architecture'],
      },
    };
    const createAssistant = vi.fn(async (request) => ({
      ...baseAssistant,
      id: request.id!,
      name: request.name,
      source: 'user' as const,
      enabled_skills: request.enabled_skills ?? [],
    }));

    await provisionTeamRoleAssistant(
      { baseAssistantId: baseAssistant.id, specialty: 'qa' },
      {
        listAssistants: vi.fn(async () => [baseAssistant]),
        getAssistant: vi.fn(async () => detailWithBaseSkill),
        createAssistant,
        updateAssistant: vi.fn(),
        setAssistantState: vi.fn(async () => undefined),
        listAvailableSkills: vi.fn(async () => skills),
        writeAssistantRule: vi.fn(async () => undefined),
      }
    );

    expect(createAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled_skills: ['architecture', 'testing'],
        defaults: expect.objectContaining({
          skills: { mode: 'fixed', value: ['architecture', 'testing'] },
        }),
      })
    );
  });

  it('creates a role assistant with copied runtime defaults, skills and persistent rules', async () => {
    const createAssistant = vi.fn(async (request) => ({
      ...baseAssistant,
      id: request.id!,
      name: request.name,
      source: 'user' as const,
      enabled_skills: request.enabled_skills ?? [],
    }));
    const writeAssistantRule = vi.fn(async () => undefined);

    const created = await provisionTeamRoleAssistant(
      { baseAssistantId: baseAssistant.id, specialty: 'qa' },
      {
        listAssistants: vi.fn(async () => [baseAssistant]),
        getAssistant: vi.fn(async () => baseDetail),
        createAssistant,
        updateAssistant: vi.fn(),
        setAssistantState: vi.fn(async () => undefined),
        listAvailableSkills: vi.fn(async () => skills),
        writeAssistantRule,
      }
    );

    expect(created.id).toBe('team-role:bare:claude:qa');
    expect(createAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team-role:bare:claude:qa',
        name: 'Claude QA',
        agent_id: 'claude-agent',
        enabled_skills: ['testing'],
        defaults: expect.objectContaining({
          model: { mode: 'fixed', value: 'claude-sonnet' },
          permission: { mode: 'fixed', value: 'yolo' },
          skills: { mode: 'fixed', value: ['testing'] },
        }),
      })
    );
    expect(writeAssistantRule).toHaveBeenCalledWith(
      'team-role:bare:claude:qa',
      TEAM_ROLE_PROFILES.qa.rules
    );
  });

  it('reuses and updates an existing managed role assistant instead of creating another', async () => {
    const existing: Assistant = {
      ...baseAssistant,
      id: 'team-role:bare:claude:qa',
      source: 'user',
      name: 'Claude QA',
    };
    const updateAssistant = vi.fn(async () => existing);
    const createAssistant = vi.fn();

    await provisionTeamRoleAssistant(
      { baseAssistantId: baseAssistant.id, specialty: 'qa' },
      {
        listAssistants: vi.fn(async () => [baseAssistant, existing]),
        getAssistant: vi.fn(async () => baseDetail),
        createAssistant,
        updateAssistant,
        setAssistantState: vi.fn(async () => undefined),
        listAvailableSkills: vi.fn(async () => skills),
        writeAssistantRule: vi.fn(async () => undefined),
      }
    );

    expect(createAssistant).not.toHaveBeenCalled();
    expect(updateAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'team-role:bare:claude:qa', enabled_skills: ['testing'] })
    );
  });
});
