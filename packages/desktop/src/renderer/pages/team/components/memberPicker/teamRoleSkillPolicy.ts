import type { TeamMemberSpecialty } from './teamMemberIdentity';

export type ProvisionableTeamMemberSpecialty = Exclude<TeamMemberSpecialty, 'general'>;

export type TeamRoleSkillPolicy = {
  /**
   * Exact skill names, ordered by preference. A role never falls back to
   * fuzzy name/description matches: if a skill is unavailable, it is skipped.
   */
  skills: readonly string[];
};

/**
 * Provenance for the curated role catalog.
 *
 * The frontend/product portion is derived from HenrryVale/skill-design.
 * Updating this SHA is an explicit review event: do not silently track main.
 */
export const TEAM_ROLE_SKILL_POLICY_SOURCE = {
  repository: 'HenrryVale/skill-design',
  commit: '822cbc69081c4b7b9b35c75da1395e012a191369',
  catalog: 'pack/skills.json',
  router: 'agent/router.yaml',
  map: 'agent/skill-map.yaml',
} as const;

/**
 * Skills that must never be selected automatically for Team role assistants.
 *
 * - canvas-design: quarantined/BLOCK in skill-design.
 * - design-taste-frontend: WARN/full-only; includes install/@latest authority.
 * - webapp-testing: WARN/full-only; audited helper can execute shell commands.
 */
export const TEAM_ROLE_AUTO_BLOCKED_SKILLS = new Set([
  'canvas-design',
  'design-taste-frontend',
  'webapp-testing',
]);

/**
 * Static role catalogs. These are capability catalogs, not instructions to
 * invoke every skill on every task. The skill-design orchestrator (Frontend /
 * Full Stack) is responsible for choosing the smallest useful subset at task
 * time.
 *
 * Deliberately omitted:
 * - office/document/presentation skills unrelated to software roles;
 * - marketing/CRO skills from generic engineering roles;
 * - WARN/BLOCK skills from the curated pack;
 * - arbitrary skills inherited from the base assistant.
 */
export const TEAM_ROLE_SKILL_POLICIES: Record<
  ProvisionableTeamMemberSpecialty,
  TeamRoleSkillPolicy
> = {
  pm: {
    skills: ['ship-gate'],
  },
  architect: {
    skills: ['architecture', 'security-gate', 'ship-gate'],
  },
  backend: {
    skills: ['testing', 'debug-gate', 'test-first-gate', 'security-gate', 'ship-gate'],
  },
  frontend: {
    skills: [
      'skill-design',
      'frontend-design',
      'refactoring-ui',
      'ui-ux-pro-max',
      'ux-heuristics',
      'web-motion-toolkit',
      'test-first-gate',
      'ship-gate',
    ],
  },
  fullstack: {
    skills: [
      'skill-design',
      'frontend-design',
      'debug-gate',
      'test-first-gate',
      'security-gate',
      'ship-gate',
    ],
  },
  qa: {
    skills: ['testing', 'ship-gate'],
  },
  security: {
    skills: ['security-gate', 'prompt-injection-gate', 'ship-gate'],
  },
  devops: {
    skills: ['debug-gate', 'security-gate', 'ship-gate'],
  },
  reviewer: {
    skills: ['architecture', 'testing', 'ship-gate'],
  },
};

export function teamRoleAllowedSkillNames(
  specialty: ProvisionableTeamMemberSpecialty
): readonly string[] {
  return TEAM_ROLE_SKILL_POLICIES[specialty].skills;
}
