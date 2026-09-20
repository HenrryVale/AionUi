import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DB_PATH = '/data/aionui-backend.db';
const DEFAULT_AUDIT_PATH = '/data/qa-guard-audit.ndjson';
const TEAM_MCP_PREFIX = 'mcp__aionui-team__';
const QA_ASSISTANT_SUFFIX = ':qa';
const PM_ASSISTANT_SUFFIX = ':pm';

const QA_LOCAL_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const QA_TEAM_READ_TOOLS = new Set([
  'team_members',
  'team_read_messages',
  'team_task_list',
]);
const QA_TASK_STATUSES = new Set(['in_progress', 'completed']);

function pass(reason = 'allowed') {
  return { decision: 'pass', reason };
}

function deny(reason) {
  return { decision: 'deny', reason };
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function pathIsInsideWorkspace(workspace, candidate) {
  if (!workspace || !candidate) return false;

  const root = canonicalPath(workspace);
  const target = canonicalPath(path.isAbsolute(candidate) ? candidate : path.join(workspace, candidate));
  const relative = path.relative(root, target);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasPathTraversalPattern(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (path.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).includes('..');
}

function localReadPath(toolName, toolInput, cwd) {
  if (toolName === 'Read') {
    const filePath = toolInput?.file_path ?? toolInput?.path;
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return deny('QA guard: Read requires a concrete file_path inside the assigned workspace.');
    }
    return pathIsInsideWorkspace(cwd, filePath)
      ? pass('QA read inside workspace')
      : deny('QA guard: reading outside the assigned workspace is not allowed.');
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    const searchRoot = toolInput?.path;
    const patterns = [
      toolName === 'Glob' ? toolInput?.pattern : null,
      toolName === 'Grep' ? toolInput?.glob : null,
    ].filter((value) => typeof value === 'string');

    if (patterns.some(hasPathTraversalPattern)) {
      return deny('QA guard: absolute or parent-traversing search patterns are not allowed.');
    }

    if (searchRoot == null || searchRoot === '') {
      return pass('QA search defaults to assigned workspace');
    }
    if (typeof searchRoot !== 'string') {
      return deny(`QA guard: ${toolName} path must be a string inside the assigned workspace.`);
    }
    return pathIsInsideWorkspace(cwd, searchRoot)
      ? pass('QA search inside workspace')
      : deny('QA guard: searching outside the assigned workspace is not allowed.');
  }

  return deny(`QA guard: local tool ${toolName} is outside the QA read-only capability set.`);
}

function teamToolName(toolName) {
  return toolName.startsWith(TEAM_MCP_PREFIX) ? toolName.slice(TEAM_MCP_PREFIX.length) : null;
}

function onlyKeys(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  return Object.keys(object).every((key) => allowed.has(key));
}

export function evaluatePmDependencyHandoff({ toolName, toolInput = {}, identity }) {
  if (!identity?.isPm) return pass('not a PM-managed dependency handoff');

  const teamTool = teamToolName(toolName);
  if (teamTool !== 'team_task_create') {
    return pass('PM tool is outside the dependency handoff guard');
  }

  const owner = toolInput?.owner;
  const blockedBy = toolInput?.blocked_by;
  const targetsQa = Array.isArray(identity.qaSlotIds) && identity.qaSlotIds.includes(owner);

  if (!targetsQa) {
    return pass('task is not assigned to QA');
  }

  if (Array.isArray(blockedBy) && blockedBy.length > 0) {
    return deny(
      'PM handoff guard: do not precreate a QA task with blocked_by. Wait until upstream work is completed, then create the QA task as immediately actionable with no blocked_by dependency.'
    );
  }

  return pass('QA task is immediately actionable');
}

export function evaluateQaTool({
  toolName,
  toolInput = {},
  cwd,
  identity,
  getTaskOwner = () => null,
}) {
  if (!identity?.enforce) return pass('not a QA-guarded session');

  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return deny('QA guard: missing tool identity; fail closed.');
  }

  if (QA_LOCAL_READ_TOOLS.has(toolName)) {
    return localReadPath(toolName, toolInput, cwd);
  }

  const teamTool = teamToolName(toolName);
  if (teamTool) {
    if (QA_TEAM_READ_TOOLS.has(teamTool)) {
      return pass(`QA Team read tool allowed: ${teamTool}`);
    }

    if (teamTool === 'team_send_message') {
      const allowedKeys = new Set(['to', 'message', 'files']);
      if (!onlyKeys(toolInput, allowedKeys)) {
        return deny('QA guard: Team messages may contain only to, message and workspace-scoped files.');
      }
      if (!identity.leadSlotId) {
        return deny('QA guard: Team lead identity is unavailable; message routing fails closed.');
      }
      if (toolInput?.to !== identity.leadSlotId) {
        return deny('QA guard: QA may send Team messages only to the lead; broadcast or peer messaging is denied.');
      }

      if (toolInput?.files != null) {
        if (
          !Array.isArray(toolInput.files) ||
          toolInput.files.some(
            (file) => typeof file !== 'string' || !pathIsInsideWorkspace(cwd, file)
          )
        ) {
          return deny('QA guard: Team message attachments must stay inside the assigned workspace.');
        }
      }

      return pass('QA may report evidence to the Team lead');
    }

    if (teamTool === 'team_task_update') {
      const allowedKeys = new Set(['task_id', 'status']);
      if (!onlyKeys(toolInput, allowedKeys)) {
        return deny('QA guard: task updates may change only QA task status.');
      }

      const taskId = toolInput?.task_id;
      const status = toolInput?.status;
      if (typeof taskId !== 'string' || !QA_TASK_STATUSES.has(status)) {
        return deny('QA guard: task update requires QA-owned task_id and status in_progress/completed.');
      }

      let owner = null;
      try {
        owner = getTaskOwner(taskId);
      } catch {
        return deny('QA guard: task ownership could not be verified; fail closed.');
      }

      if (!identity.slotId || owner !== identity.slotId) {
        return deny('QA guard: QA may update only its own assigned task.');
      }

      return pass('QA may update only its own task lifecycle status');
    }

    return deny(`QA guard: Team tool ${teamTool} is outside the QA coordination capability set.`);
  }

  return deny(`QA guard: tool ${toolName} is denied. QA is read-only and may not execute, mutate, delegate, or bypass the capability wall.`);
}

function parseAgents(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveQaIdentity(db, sessionId, permissionMode) {
  let conversationId = null;
  let assistantId = null;

  if (sessionId) {
    const session = db
      .prepare('SELECT conversation_id FROM acp_session WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    conversationId = session?.conversation_id ?? null;
  }

  if (conversationId) {
    const snapshot = db
      .prepare('SELECT assistant_id FROM conversation_assistant_snapshots WHERE conversation_id = ? LIMIT 1')
      .get(conversationId);
    assistantId = snapshot?.assistant_id ?? null;
  }

  let teamId = null;
  let slotId = null;
  let leadSlotId = null;
  let qaSlotIds = [];

  if (conversationId) {
    const teams = db
      .prepare('SELECT id, agents FROM teams ORDER BY created_at DESC LIMIT 200')
      .all();

    for (const row of teams) {
      const agents = parseAgents(row.agents);
      const member = agents.find((agent) => agent?.conversation_id === conversationId);
      if (!member) continue;

      teamId = row.id;
      slotId = member.slot_id ?? null;
      leadSlotId = agents.find((agent) => agent?.role === 'lead')?.slot_id ?? null;
      qaSlotIds = agents
        .filter(
          (agent) =>
            typeof agent?.assistant_id === 'string' &&
            agent.assistant_id.endsWith(QA_ASSISTANT_SUFFIX)
        )
        .map((agent) => agent.slot_id)
        .filter(Boolean);
      break;
    }
  }

  const knownQa = typeof assistantId === 'string' && assistantId.endsWith(QA_ASSISTANT_SUFFIX);
  const knownPm = typeof assistantId === 'string' && assistantId.endsWith(PM_ASSISTANT_SUFFIX);
  const knownNonQa = typeof assistantId === 'string' && !knownQa;
  const planFallback = !assistantId && permissionMode === 'plan';

  return {
    enforce: knownQa || planFallback,
    isPm: knownPm,
    identitySource: knownQa
      ? 'assistant-id'
      : knownPm
        ? 'pm-assistant-id'
        : planFallback
          ? 'plan-fallback'
          : knownNonQa
            ? 'non-qa'
            : 'unknown',
    assistantId,
    conversationId,
    teamId,
    slotId,
    leadSlotId,
    qaSlotIds,
  };
}

function auditDecision(input, identity, result, auditPath = DEFAULT_AUDIT_PATH) {
  const record = {
    ts: new Date().toISOString(),
    session_id: input?.session_id ?? input?.sessionId ?? null,
    conversation_id: identity?.conversationId ?? null,
    assistant_id: identity?.assistantId ?? null,
    team_id: identity?.teamId ?? null,
    slot_id: identity?.slotId ?? null,
    identity_source: identity?.identitySource ?? 'unknown',
    tool_name: input?.tool_name ?? input?.toolName ?? null,
    decision: result.decision,
    reason: result.reason,
  };

  try {
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Audit failure must never weaken the policy decision.
  }
}

function denyPayload(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function main({
  dbPath = process.env.AIONUI_DATA_DIR
    ? path.join(process.env.AIONUI_DATA_DIR, 'aionui-backend.db')
    : DEFAULT_DB_PATH,
  auditPath = DEFAULT_AUDIT_PATH,
} = {}) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input?.session_id ?? input?.sessionId ?? null;
  const permissionMode = input?.permission_mode ?? input?.permissionMode ?? null;
  const toolName = input?.tool_name ?? input?.toolName ?? '';
  const toolInput = input?.tool_input ?? input?.toolInput ?? {};
  const cwd = input?.cwd ?? process.cwd();

  let db;
  let identity = null;

  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    identity = resolveQaIdentity(db, sessionId, permissionMode);
  } catch {
    // If identity lookup fails while Claude itself reports plan mode, fail closed
    // for that restrictive session. Non-plan sessions remain unaffected.
    identity = {
      enforce: permissionMode === 'plan',
      identitySource: permissionMode === 'plan' ? 'plan-fallback-db-error' : 'unknown-db-error',
      assistantId: null,
      conversationId: null,
      teamId: null,
      slotId: null,
      leadSlotId: null,
    };
  }

  const pmHandoff = evaluatePmDependencyHandoff({
    toolName,
    toolInput,
    identity,
  });

  if (pmHandoff.decision === 'deny') {
    auditDecision(input, identity, pmHandoff, auditPath);
    db?.close?.();
    process.stdout.write(JSON.stringify(denyPayload(pmHandoff.reason)));
    return;
  }

  if (!identity.enforce) {
    db?.close?.();
    return;
  }

  const getTaskOwner = (taskId) => {
    if (!db || !identity.teamId) return null;
    return (
      db
        .prepare('SELECT owner FROM team_tasks WHERE id = ? AND team_id = ? LIMIT 1')
        .get(taskId, identity.teamId)?.owner ?? null
    );
  };

  const result = evaluateQaTool({
    toolName,
    toolInput,
    cwd,
    identity,
    getTaskOwner,
  });

  auditDecision(input, identity, result, auditPath);
  db?.close?.();

  if (result.decision === 'deny') {
    process.stdout.write(JSON.stringify(denyPayload(result.reason)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
