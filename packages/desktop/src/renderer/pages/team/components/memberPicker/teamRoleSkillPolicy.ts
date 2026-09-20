import type { TeamMemberSpecialty } from './teamMemberIdentity';

export type ProvisionableTeamMemberSpecialty = Exclude<TeamMemberSpecialty, 'general'>;

export type TeamRoleSkillPolicy = {
  /**
   * Exact skill names, ordered by preference. A role never falls back to
   * fuzzy name/description matches. Missing managed skills are imported from
   * the pinned immutable bundle and provisioning fails closed if they remain unavailable.
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
  commit: '75e78abdf42deee73cbe51199806afdb8eebf539',
  rolePolicy: 'pack/aionui-team-roles.json',
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
 * Static role catalogs. These are capability surfaces, not instructions to
 * invoke every skill on every task. Frontend intentionally exposes the audited
 * UI/product toolbox from skill-design; the skill-design orchestrator is still
 * responsible for selecting one primary capability, a small support set, and
 * gates only when the task warrants them.
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
    skills: ['security-gate', 'prompt-injection-gate', 'ship-gate'],
  },
  backend: {
    skills: [
      'debug-gate',
      'test-first-gate',
      'security-gate',
      'prompt-injection-gate',
      'ship-gate',
    ],
  },
  frontend: {
    skills: [
      'skill-design',
      'frontend-design',
      'refactoring-ui',
      'ui-ux-pro-max',
      'ux-heuristics',
      'web-typography',
      'microinteractions',
      'theme-factory',
      'web-motion-toolkit',
      'web-artifact-builder',
      'generative-art',
      'business-identity-gate',
      'prompt-injection-gate',
      'test-first-gate',
      'security-gate',
      'ship-gate',
    ],
  },
  fullstack: {
    skills: [
      'skill-design',
      'frontend-design',
      'web-artifact-builder',
      'debug-gate',
      'test-first-gate',
      'security-gate',
      'prompt-injection-gate',
      'ship-gate',
    ],
  },
  qa: {
    skills: ['ship-gate'],
  },
  security: {
    skills: ['security-gate', 'prompt-injection-gate', 'ship-gate'],
  },
  devops: {
    skills: ['debug-gate', 'security-gate', 'prompt-injection-gate', 'ship-gate'],
  },
  reviewer: {
    skills: ['ship-gate'],
  },
};

export const TEAM_ROLE_SKILL_BUNDLE_ROOT =
  `/app/team-skills/${TEAM_ROLE_SKILL_POLICY_SOURCE.commit}`;

export function teamRoleAllowedSkillNames(
  specialty: ProvisionableTeamMemberSpecialty
): readonly string[] {
  return TEAM_ROLE_SKILL_POLICIES[specialty].skills;
}

export function teamRoleSkillBundlePath(skillName: string): string {
  return `${TEAM_ROLE_SKILL_BUNDLE_ROOT}/${skillName}`;
}
