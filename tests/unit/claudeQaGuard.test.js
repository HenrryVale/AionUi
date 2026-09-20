import { describe, expect, it } from 'vitest';
import {
  evaluateQaTool,
  pathIsInsideWorkspace,
} from '../../scripts/runtime/claude-qa-guard.mjs';

const qa = {
  enforce: true,
  assistantId: 'team-role:bare:claude:qa',
  conversationId: 'conv-qa',
  teamId: 'team-1',
  slotId: 'slot-qa',
  leadSlotId: 'slot-pm',
};

const nonQa = {
  ...qa,
  enforce: false,
  assistantId: 'team-role:bare:claude:backend',
};

function evaluate(toolName, toolInput = {}, overrides = {}) {
  return evaluateQaTool({
    toolName,
    toolInput,
    cwd: '/workspace/AionUi',
    identity: qa,
    getTaskOwner: () => 'slot-qa',
    ...overrides,
  });
}

describe('Claude QA capability guard', () => {
  it('does not constrain a non-QA session', () => {
    expect(
      evaluateQaTool({
        toolName: 'Bash',
        toolInput: { command: 'printf unsafe > file' },
        cwd: '/workspace/AionUi',
        identity: nonQa,
      })
    ).toEqual({ decision: 'pass', reason: 'not a QA-guarded session' });
  });

  it('allows Read, Glob and Grep only inside the assigned workspace', () => {
    expect(evaluate('Read', { file_path: '/workspace/AionUi/package.json' }).decision).toBe('pass');
    expect(evaluate('Glob', { path: '/workspace/AionUi/packages', pattern: '**/*.ts' }).decision).toBe('pass');
    expect(evaluate('Grep', { path: '.', pattern: 'team' }).decision).toBe('pass');

    expect(evaluate('Read', { file_path: '/data/aionui-backend.db' }).decision).toBe('deny');
    expect(evaluate('Grep', { path: '/home/aionui', pattern: 'token' }).decision).toBe('deny');
  });

  it('denies execution, mutation and delegation tools fail-closed', () => {
    for (const toolName of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch']) {
      expect(evaluate(toolName, {}).decision, toolName).toBe('deny');
    }
  });

  it('allows only the QA read subset of Team MCP tools', () => {
    for (const name of ['team_members', 'team_read_messages', 'team_task_list']) {
      expect(evaluate(`mcp__aionui-team__${name}`, {}).decision, name).toBe('pass');
    }

    for (const name of [
      'team_task_create',
      'team_interrupt_agent',
      'team_list_assistants',
      'team_describe_assistant',
      'team_spawn_agent',
      'team_rename_agent',
      'team_clear_agent_context',
      'team_shutdown_agent',
    ]) {
      expect(evaluate(`mcp__aionui-team__${name}`, {}).decision, name).toBe('deny');
    }
  });

  it('allows QA to report only to the lead and denies broadcast or peer messaging', () => {
    expect(
      evaluate('mcp__aionui-team__team_send_message', {
        to: 'slot-pm',
        message: 'PASS with evidence',
      }).decision
    ).toBe('pass');

    expect(
      evaluate('mcp__aionui-team__team_send_message', {
        to: 'slot-dev',
        message: 'do something',
      }).decision
    ).toBe('deny');

    expect(
      evaluate('mcp__aionui-team__team_send_message', {
        to: '*',
        message: 'broadcast',
      }).decision
    ).toBe('deny');
  });

  it('allows only lifecycle status updates on the QA-owned task', () => {
    expect(
      evaluate('mcp__aionui-team__team_task_update', {
        task_id: 'task-qa',
        status: 'completed',
      }).decision
    ).toBe('pass');

    expect(
      evaluate('mcp__aionui-team__team_task_update', {
        task_id: 'task-qa',
        status: 'in_progress',
      }).decision
    ).toBe('pass');

    expect(
      evaluate('mcp__aionui-team__team_task_update', {
        task_id: 'task-qa',
        status: 'completed',
        description: 'rewrite task',
      }).decision
    ).toBe('deny');

    expect(
      evaluate(
        'mcp__aionui-team__team_task_update',
        { task_id: 'task-dev', status: 'completed' },
        { getTaskOwner: () => 'slot-dev' }
      ).decision
    ).toBe('deny');

    expect(
      evaluate('mcp__aionui-team__team_task_update', {
        task_id: 'task-qa',
        status: 'deleted',
      }).decision
    ).toBe('deny');
  });

  it('denies arbitrary MCP servers and unknown tools', () => {
    expect(evaluate('mcp__filesystem__write_file', {}).decision).toBe('deny');
    expect(evaluate('SomeFutureMutationTool', {}).decision).toBe('deny');
  });

  it('recognizes workspace containment without prefix tricks', () => {
    expect(pathIsInsideWorkspace('/workspace/AionUi', '/workspace/AionUi/packages')).toBe(true);
    expect(pathIsInsideWorkspace('/workspace/AionUi', '/workspace/AionUi-evil')).toBe(false);
    expect(pathIsInsideWorkspace('/workspace/AionUi', '../secrets')).toBe(false);
  });
});
