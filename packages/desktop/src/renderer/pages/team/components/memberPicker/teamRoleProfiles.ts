import { ipcBridge } from '@/common';
import type {
  Assistant,
  AssistantDefaultsRequest,
  AssistantDetail,
  CreateAssistantRequest,
  UpdateAssistantRequest,
} from '@/common/types/agent/assistantTypes';
import type { SkillInfo } from '@/renderer/pages/settings/AssistantSettings/types';
import type { TeamMemberSpecialty } from './teamMemberIdentity';

export type ProvisionableTeamMemberSpecialty = Exclude<TeamMemberSpecialty, 'general'>;

type TeamRoleProfile = {
  label: string;
  description: string;
  rules: string;
  skillKeywords: string[];
};

const COMMON_TURN_END_RULES = `
Coordination lifecycle:
- Work only on the task(s) explicitly assigned to you.
- When an assigned task is finished, update it to completed and send the leader ONE concise final delivery.
- After that delivery, END YOUR TURN. Do not send acknowledgements, "still waiting" messages, repeated completion notices, or responses to idle notifications.
- A completed task is closed unless the leader explicitly assigns new work.
`.trim();

export const TEAM_ROLE_PROFILES: Record<ProvisionableTeamMemberSpecialty, TeamRoleProfile> = {
  pm: {
    label: 'PM',
    description: 'Coordinates the team, decomposes goals, delegates work and consolidates results.',
    skillKeywords: ['planning', 'project', 'requirements', 'product', 'task', 'coordination'],
    rules: `
You are the Project Manager and Team Lead.

Responsibilities:
- Understand the user's objective, constraints and acceptance criteria.
- Decompose substantial work into concrete, bounded tasks with clear owners and dependencies.
- Delegate implementation to developers, validation to QA, and security review to Security when relevant.
- Track task state and unblock dependencies without micromanaging active teammates.
- Consolidate teammate evidence into the final answer to the user.

Boundaries:
- Prefer delegation over implementing code yourself when an appropriate teammate is available.
- Do not wake a teammate merely to acknowledge a result.
- Do not respond to idle notifications.
- Do not reopen a completed task without a concrete new reason.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  architect: {
    label: 'Architect',
    description: 'Designs system boundaries, interfaces, data flows and technical trade-offs.',
    skillKeywords: ['architecture', 'system design', 'design', 'api', 'integration'],
    rules: `
You are the Software Architect.

Responsibilities:
- Analyze requirements and existing architecture before proposing structural changes.
- Define boundaries, interfaces, data flows, contracts and migration paths.
- Make trade-offs explicit: complexity, operability, performance, security and maintainability.
- Produce implementable guidance for developers rather than vague diagrams.

Boundaries:
- Do not perform broad implementation unless the assigned task explicitly requires it.
- Prefer minimal architecture changes that fit the existing system.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  backend: {
    label: 'Dev',
    description: 'Implements backend changes with minimal, testable and traceable code modifications.',
    skillKeywords: ['backend', 'architecture', 'api', 'spring', 'java', 'testing', 'debug'],
    rules: `
You are the Backend Developer.

Responsibilities:
- Inspect the relevant code and tests before changing anything.
- Implement only the assigned scope using the repository's existing conventions.
- Keep changes minimal, reviewable and traceable.
- Run the most relevant tests or checks available and report their results.
- Report changed files, important implementation decisions and remaining risks.

Boundaries:
- Do not expand scope without telling the leader.
- Do not declare success without evidence from code inspection and relevant checks.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  frontend: {
    label: 'Frontend',
    description: 'Implements frontend and UI changes while preserving existing interaction patterns.',
    skillKeywords: ['frontend', 'react', 'ui', 'ux', 'accessibility', 'testing'],
    rules: `
You are the Frontend Developer.

Responsibilities:
- Inspect the current component, state and styling patterns before changing UI code.
- Preserve responsive behavior, accessibility and existing test selectors unless the task intentionally changes them.
- Implement the smallest coherent UI change and update relevant tests.
- Report visual/interaction implications and test evidence.

Boundaries:
- Do not redesign unrelated surfaces.
- Do not change backend contracts unless the task explicitly includes that work.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  fullstack: {
    label: 'Full Stack',
    description: 'Implements coordinated frontend and backend changes across a complete feature slice.',
    skillKeywords: ['architecture', 'backend', 'frontend', 'api', 'testing', 'debug'],
    rules: `
You are the Full Stack Developer.

Responsibilities:
- Trace the complete feature flow across UI, API, persistence and runtime boundaries.
- Implement only the assigned vertical slice while preserving established contracts.
- Update relevant tests on both sides of the boundary.
- Report changed files, contract changes, validation evidence and risks.

Boundaries:
- Avoid unrelated refactors while implementing the requested slice.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  qa: {
    label: 'QA',
    description: 'Validates acceptance criteria, regressions and edge cases with reproducible evidence.',
    skillKeywords: ['testing', 'test', 'qa', 'quality', 'regression'],
    rules: `
You are the QA Engineer.

Responsibilities:
- Translate acceptance criteria into explicit checks.
- Inspect relevant tests and execute the strongest available validation.
- Look for regressions, boundary cases, race conditions and error paths.
- Report PASS or FAIL with reproducible evidence, including commands and observed results.

Boundaries:
- Do NOT modify the implementation during a validation task.
- If you find a defect, report it to the leader with evidence. Only modify code if the leader explicitly assigns a repair task.
- Never convert a failed test into a pass by weakening the assertion unless that behavior change is explicitly required.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  security: {
    label: 'Security',
    description: 'Reviews trust boundaries, permissions, secrets, inputs and dependency risks.',
    skillKeywords: ['security', 'secure', 'audit', 'threat', 'vulnerability', 'permission'],
    rules: `
You are the Security Reviewer.

Responsibilities:
- Identify trust boundaries, attacker-controlled inputs and privileged operations.
- Review authentication, authorization, secret handling, command/file access and dependency exposure.
- Rank findings by concrete impact and exploitability, with file/flow evidence.
- Recommend the smallest effective mitigation and note residual risk.

Boundaries:
- Do not modify implementation during a review unless the leader explicitly assigns a repair task.
- Do not report hypothetical issues as confirmed vulnerabilities without evidence.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  devops: {
    label: 'DevOps',
    description: 'Owns build, deployment, runtime configuration and operational reliability changes.',
    skillKeywords: ['devops', 'docker', 'deploy', 'deployment', 'ci', 'cd', 'infrastructure', 'operations'],
    rules: `
You are the DevOps Engineer.

Responsibilities:
- Inspect the existing build and deployment path before changing runtime configuration.
- Preserve reproducibility, least privilege, persisted state and rollback capability.
- Validate container/image/runtime changes with concrete smoke checks.
- Report operational impact, rollback steps and evidence.

Boundaries:
- Do not remove persistent data or credentials as part of a deployment change.
- Prefer reversible changes and explicit version pinning.
${COMMON_TURN_END_RULES}
`.trim(),
  },
  reviewer: {
    label: 'Reviewer',
    description: 'Reviews code changes for correctness, maintainability and regression risk.',
    skillKeywords: ['review', 'code review', 'testing', 'quality', 'architecture'],
    rules: `
You are the Code Reviewer.

Responsibilities:
- Review the actual diff and surrounding code, not only the author's summary.
- Prioritize correctness, regression risk, maintainability and missing tests.
- Separate confirmed defects from suggestions.
- Report findings with concrete file/behavior evidence.

Boundaries:
- Do not rewrite the implementation during the review unless explicitly assigned a repair task.
- Do not approve based solely on intent; require evidence.
${COMMON_TURN_END_RULES}
`.trim(),
  },
};

export function teamRoleAssistantId(baseAssistantId: string, specialty: ProvisionableTeamMemberSpecialty): string {
  return `team-role:${baseAssistantId}:${specialty}`;
}

function normalizedSkillText(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function skillScore(skill: SkillInfo, keywords: string[]): number {
  const name = normalizedSkillText(skill.name);
  const description = normalizedSkillText(skill.description || '');
  let score = 0;

  for (const rawKeyword of keywords) {
    const keyword = normalizedSkillText(rawKeyword);
    if (!keyword) continue;
    if (name === keyword) score += 12;
    else if (name.includes(keyword)) score += 7;
    if (description.includes(keyword)) score += 2;
  }

  return score;
}

export function resolveTeamRoleSkills(
  specialty: ProvisionableTeamMemberSpecialty,
  availableSkills: SkillInfo[],
  maxSkills = 4
): SkillInfo[] {
  const keywords = TEAM_ROLE_PROFILES[specialty].skillKeywords;
  return availableSkills
    .map((skill) => ({ skill, score: skillScore(skill, keywords) }))
    .filter((entry) => entry.score > 0 && !entry.skill.is_auto_inject)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, maxSkills)
    .map((entry) => entry.skill);
}

export type TeamRoleProfileDeps = {
  listAssistants: () => Promise<Assistant[]>;
  getAssistant: (id: string) => Promise<AssistantDetail>;
  createAssistant: (request: CreateAssistantRequest) => Promise<Assistant>;
  updateAssistant: (request: UpdateAssistantRequest) => Promise<Assistant>;
  setAssistantState: (id: string, enabled: boolean) => Promise<unknown>;
  listAvailableSkills: () => Promise<SkillInfo[]>;
  writeAssistantRule: (assistantId: string, content: string) => Promise<unknown>;
};

const liveDeps: TeamRoleProfileDeps = {
  listAssistants: () => ipcBridge.assistants.list.invoke(),
  getAssistant: (id) => ipcBridge.assistants.get.invoke({ id, locale: 'en-US' }),
  createAssistant: (request) => ipcBridge.assistants.create.invoke(request),
  updateAssistant: (request) => ipcBridge.assistants.update.invoke(request),
  setAssistantState: (id, enabled) => ipcBridge.assistants.setState.invoke({ id, enabled }),
  listAvailableSkills: () => ipcBridge.fs.listAvailableSkills.invoke(),
  writeAssistantRule: (assistantId, content) =>
    ipcBridge.fs.writeAssistantRule.invoke({ assistant_id: assistantId, locale: 'en-US', content }),
};

function cloneBaseDefaults(detail: AssistantDetail, skillNames: string[]): AssistantDefaultsRequest {
  return {
    model:
      detail.defaults.model.mode === 'fixed' && detail.defaults.model.value
        ? { mode: 'fixed', value: detail.defaults.model.value }
        : { mode: 'auto' },
    permission:
      detail.defaults.permission.mode === 'fixed' && detail.defaults.permission.value
        ? { mode: 'fixed', value: detail.defaults.permission.value }
        : { mode: 'auto' },
    thought_level:
      detail.defaults.thought_level.mode === 'fixed' && detail.defaults.thought_level.value
        ? { mode: 'fixed', value: detail.defaults.thought_level.value }
        : { mode: 'auto' },
    skills: { mode: 'fixed', value: skillNames },
    mcps:
      detail.defaults.mcps.mode === 'fixed'
        ? { mode: 'fixed', value: detail.defaults.mcps.value ?? [] }
        : { mode: 'auto', value: [] },
  };
}

export type EnsureTeamRoleAssistantInput = {
  baseAssistantId: string;
  specialty: ProvisionableTeamMemberSpecialty;
};

export async function provisionTeamRoleAssistant(
  input: EnsureTeamRoleAssistantInput,
  deps: TeamRoleProfileDeps
): Promise<Assistant> {
  const assistants = await deps.listAssistants();
  const base = assistants.find((assistant) => assistant.id === input.baseAssistantId);
  if (!base) {
    throw new Error(`Base assistant not found: ${input.baseAssistantId}`);
  }
  if (!base.agent_id) {
    throw new Error(`Base assistant has no agent binding: ${base.id}`);
  }

  const profile = TEAM_ROLE_PROFILES[input.specialty];
  const roleAssistantId = teamRoleAssistantId(base.id, input.specialty);
  const [baseDetail, availableSkills] = await Promise.all([
    deps.getAssistant(base.id),
    deps.listAvailableSkills(),
  ]);
  const matchedSkills = resolveTeamRoleSkills(input.specialty, availableSkills);
  const skillNames = Array.from(
    new Set([...(baseDetail.capabilities.default_skill_ids ?? []), ...matchedSkills.map((skill) => skill.name)])
  );
  const customSkillNames = Array.from(
    new Set([
      ...(baseDetail.capabilities.custom_skill_names ?? []),
      ...matchedSkills.filter((skill) => skill.is_custom).map((skill) => skill.name),
    ])
  );
  const disabledBuiltinSkills = baseDetail.capabilities.default_disabled_builtin_skill_ids ?? [];
  const name = `${base.name} ${profile.label}`;
  const description = `[Team Role Profile v1] ${profile.description}`;
  const defaults = cloneBaseDefaults(baseDetail, skillNames);

  const existing = assistants.find((assistant) => assistant.id === roleAssistantId);
  let roleAssistant: Assistant;

  if (existing) {
    roleAssistant = await deps.updateAssistant({
      id: roleAssistantId,
      name,
      description,
      avatar: base.avatar,
      agent_id: base.agent_id,
      enabled_skills: skillNames,
      custom_skill_names: customSkillNames,
      disabled_builtin_skills: disabledBuiltinSkills,
      defaults,
    });
  } else {
    roleAssistant = await deps.createAssistant({
      id: roleAssistantId,
      name,
      description,
      avatar: base.avatar,
      agent_id: base.agent_id,
      enabled_skills: skillNames,
      custom_skill_names: customSkillNames,
      disabled_builtin_skills: disabledBuiltinSkills,
      defaults,
    });
  }

  await deps.writeAssistantRule(roleAssistantId, profile.rules);
  if (!roleAssistant.enabled) {
    await deps.setAssistantState(roleAssistantId, true);
    roleAssistant = { ...roleAssistant, enabled: true };
  }

  return roleAssistant;
}

export async function ensureTeamRoleAssistant(input: EnsureTeamRoleAssistantInput): Promise<Assistant> {
  return provisionTeamRoleAssistant(input, liveDeps);
}
