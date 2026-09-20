export type TeamMemberSpecialty =
  | 'general'
  | 'pm'
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'qa'
  | 'security'
  | 'devops'
  | 'reviewer';

export type TeamMemberSpecialtyOption = {
  value: TeamMemberSpecialty;
  label: string;
  suffix: string;
};

export const TEAM_MEMBER_SPECIALTIES: TeamMemberSpecialtyOption[] = [
  { value: 'general', label: 'General', suffix: '' },
  { value: 'pm', label: 'PM / Lead', suffix: 'PM' },
  { value: 'architect', label: 'Architect', suffix: 'Architect' },
  { value: 'backend', label: 'Backend Developer', suffix: 'Backend' },
  { value: 'frontend', label: 'Frontend Developer', suffix: 'Frontend' },
  { value: 'fullstack', label: 'Full Stack Developer', suffix: 'Full Stack' },
  { value: 'qa', label: 'QA / Testing', suffix: 'QA' },
  { value: 'security', label: 'Security', suffix: 'Security' },
  { value: 'devops', label: 'DevOps', suffix: 'DevOps' },
  { value: 'reviewer', label: 'Reviewer', suffix: 'Reviewer' },
];

function specialtySuffix(specialty: TeamMemberSpecialty): string {
  return TEAM_MEMBER_SPECIALTIES.find((option) => option.value === specialty)?.suffix ?? '';
}

export function normalizeTeamMemberName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function composeTeamMemberName(baseName: string, specialty: TeamMemberSpecialty): string {
  const name = baseName.trim().replace(/\s+/g, ' ');
  if (!name) return '';

  const suffix = specialtySuffix(specialty);
  if (!suffix) return name;

  const normalizedName = normalizeTeamMemberName(name);
  const normalizedSuffix = normalizeTeamMemberName(suffix);
  if (
    normalizedName === normalizedSuffix ||
    normalizedName.endsWith(` ${normalizedSuffix}`) ||
    normalizedName.endsWith(` · ${normalizedSuffix}`)
  ) {
    return name;
  }

  return `${name} ${suffix}`;
}

export function nextAvailableTeamMemberName(baseName: string, existingNames: string[]): string {
  const trimmedBase = baseName.trim().replace(/\s+/g, ' ') || 'Assistant';
  const existing = new Set(existingNames.map(normalizeTeamMemberName));

  if (!existing.has(normalizeTeamMemberName(trimmedBase))) {
    return trimmedBase;
  }

  let copy = 2;
  while (existing.has(normalizeTeamMemberName(`${trimmedBase} ${copy}`))) {
    copy += 1;
  }
  return `${trimmedBase} ${copy}`;
}

export function duplicateTeamMemberNames(names: string[]): string[] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const rawName of names) {
    const display = rawName.trim().replace(/\s+/g, ' ');
    if (!display) continue;
    const normalized = normalizeTeamMemberName(display);
    const current = counts.get(normalized);
    counts.set(normalized, {
      display: current?.display ?? display,
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...counts.values()].filter((entry) => entry.count > 1).map((entry) => entry.display);
}
