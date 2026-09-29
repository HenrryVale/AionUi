import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateQaTool,
  readOnlyRoleFromAssistantId,
} from './claude-qa-guard.mjs';

const WORKSPACE = '/workspace/project';
const GUARDED_ROLES = ['qa', 'security', 'architect', 'reviewer'];
const UNGUARDED_ROLES = ['pm', 'backend', 'frontend', 'fullstack', 'devops'];

function identity(role, enforce = true) {
  return {
    enforce,
    guardRole: role,
    slotId: `slot-${role}`,
    leadSlotId: 'slot-pm',
  };
}

test('recognizes exactly the four read-only Team role suffixes', () => {
  for (const role of GUARDED_ROLES) {
    assert.equal(
      readOnlyRoleFromAssistantId(`team-role:bare:2d23ff1c:${role}`),
      role
    );
  }

  for (const role of UNGUARDED_ROLES) {
    assert.equal(
      readOnlyRoleFromAssistantId(`team-role:bare:2d23ff1c:${role}`),
      null
    );
  }
});

for (const role of GUARDED_ROLES) {
  test(`${role} allows workspace reads and denies filesystem/process mutation`, () => {
    const guarded = identity(role);

    assert.equal(
      evaluateQaTool({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/project/src/index.ts' },
        cwd: WORKSPACE,
        identity: guarded,
      }).decision,
      'pass'
    );

    assert.equal(
      evaluateQaTool({
        toolName: 'Read',
        toolInput: { file_path: '/etc/passwd' },
        cwd: WORKSPACE,
        identity: guarded,
      }).decision,
      'deny'
    );

    for (const toolName of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Task', 'AskUserQuestion']) {
      assert.equal(
        evaluateQaTool({
          toolName,
          toolInput: {},
          cwd: WORKSPACE,
          identity: guarded,
        }).decision,
        'deny',
        `${role} unexpectedly allowed ${toolName}`
      );
    }
  });

  test(`${role} may report to the lead but not message peers`, () => {
    const guarded = identity(role);

    assert.equal(
      evaluateQaTool({
        toolName: 'mcp__aionui-team__team_send_message',
        toolInput: { to: 'slot-pm', message: 'evidence' },
        cwd: WORKSPACE,
        identity: guarded,
      }).decision,
      'pass'
    );

    assert.equal(
      evaluateQaTool({
        toolName: 'mcp__aionui-team__team_send_message',
        toolInput: { to: 'slot-dev', message: 'please execute this' },
        cwd: WORKSPACE,
        identity: guarded,
      }).decision,
      'deny'
    );
  });
}

test('implementation roles and PM remain outside the read-only wall', () => {
  for (const role of UNGUARDED_ROLES) {
    const unguarded = identity(role, false);
    assert.equal(
      evaluateQaTool({
        toolName: 'Write',
        toolInput: { file_path: '/workspace/project/out.txt' },
        cwd: WORKSPACE,
        identity: unguarded,
      }).decision,
      'pass',
      `${role} was accidentally placed behind the read-only wall`
    );
  }
});

test('read-only role task lifecycle remains limited to its own task', () => {
  const guarded = identity('security');

  assert.equal(
    evaluateQaTool({
      toolName: 'mcp__aionui-team__team_task_update',
      toolInput: { task_id: 'task-security', status: 'completed' },
      cwd: WORKSPACE,
      identity: guarded,
      getTaskOwner: () => 'slot-security',
    }).decision,
    'pass'
  );

  assert.equal(
    evaluateQaTool({
      toolName: 'mcp__aionui-team__team_task_update',
      toolInput: { task_id: 'task-dev', status: 'completed' },
      cwd: WORKSPACE,
      identity: guarded,
      getTaskOwner: () => 'slot-dev',
    }).decision,
    'deny'
  );
});
