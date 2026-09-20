import { describe, expect, it } from 'vitest';
import {
  composeTeamMemberName,
  duplicateTeamMemberNames,
  nextAvailableTeamMemberName,
  normalizeTeamMemberName,
} from '@/renderer/pages/team/components/memberPicker/teamMemberIdentity';

describe('team member identity helpers', () => {
  it('composes a specialty into the persisted team member name', () => {
    expect(composeTeamMemberName('Claude', 'pm')).toBe('Claude PM');
    expect(composeTeamMemberName('Claude', 'qa')).toBe('Claude QA');
    expect(composeTeamMemberName('Claude', 'backend')).toBe('Claude Dev');
  });

  it('does not append the same specialty twice', () => {
    expect(composeTeamMemberName('Claude QA', 'qa')).toBe('Claude QA');
    expect(composeTeamMemberName('Claude · QA', 'qa')).toBe('Claude · QA');
  });

  it('keeps general members unchanged', () => {
    expect(composeTeamMemberName(' Claude   Code ', 'general')).toBe('Claude Code');
  });

  it('allocates unique names when the same assistant is added repeatedly', () => {
    expect(nextAvailableTeamMemberName('Claude', [])).toBe('Claude');
    expect(nextAvailableTeamMemberName('Claude', ['Claude'])).toBe('Claude 2');
    expect(nextAvailableTeamMemberName('Claude', ['Claude', 'Claude 2'])).toBe('Claude 3');
  });

  it('detects duplicates case-insensitively and ignores spacing differences', () => {
    expect(duplicateTeamMemberNames(['Claude QA', ' claude   qa ', 'Claude Dev'])).toEqual(['Claude QA']);
  });

  it('normalizes names for backend-safe uniqueness checks', () => {
    expect(normalizeTeamMemberName(' Claude   QA ')).toBe('claude qa');
  });
});
