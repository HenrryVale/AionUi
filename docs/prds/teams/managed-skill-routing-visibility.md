# Managed Skill Routing Visibility

## Scope

This change closes the A1 Frontend routing false-positive and makes the managed
skills selected for each Team turn visible in the chat UI.

It does **not** change the role allowlists, the pinned `router.yaml`, or the
security-gate vocabulary. It changes which text is treated as task intent and
adds user-visible audit metadata for the route that was actually selected.

## Problem

A Team wake payload contains two different kinds of text:

1. Team Governance / role / tool instructions.
2. The semantic task payload, such as the latest user mailbox message.

FIX-2B routed on the whole `SendMessageData.content`. Governance contains words
such as `permission`, `authorization`, `secret`, and `password`, so a
read-only UX audit incorrectly selected `security-gate`.

The existing conversation skills indicator is different: it shows the skills
mounted on the conversation snapshot, not the subset selected for one turn.

## Design

### Semantic task scope

Before classification and gate selection:

- If the Team wake payload has `## New Messages`, select the latest
  `- From `user` [message]: ...` body.
- Stop before the next mailbox message.
- If there is no direct user mailbox item, use the task-board section as the
  teammate wake-up fallback.
- If the payload is not a standard Team wrapper, preserve the existing
  fail-closed classifier behavior but do not re-introduce Governance text.

Both route classification and mandatory-gate detection use this same semantic
task scope.

### Per-turn routing visibility

When managed routing succeeds, the direct CLI session emits a durable
informational tip with code `MANAGED_SKILL_ROUTING` and parameters:

- `task_class`
- `route`
- `primary`
- `supports`
- `gates`
- `loaded_skills`

The tip is emitted after the turn `Start` event and before model dispatch.
The existing stream relay forwards and persists informational tips, so the
routing card is visible live and after a conversation reload without adding a
database schema or a new message type.

The fallback text says "Loaded skills" rather than "used skills" because this
metadata proves which skill bodies were selected and injected into the model
input. It does not claim that a failed provider dispatch consumed them.

### Chat UI

`MessageTips` recognizes `MANAGED_SKILL_ROUTING` and renders a compact card:

- loaded skill count,
- route,
- primary skill,
- support skills,
- mandatory gates when present,
- task class.

The existing conversation-level skills indicator remains unchanged.

## Validation

A1 acceptance after rebuilding the image:

- Frontend role skill view remains exactly 16 / 16 / 16.
- Read-only UX audit routes to `design.ux_audit`.
- Primary is `ux-heuristics`.
- Support is `refactoring-ui`.
- Gates are empty.
- A real sensitive user task still selects `security-gate`.
- The transcript contains the managed routing preamble and the selected skill
  bodies.
- The chat shows the persisted managed-skill routing card.
- Reloading the conversation keeps the same card.
- No out-of-allowlist skills appear in the effective Frontend runtime surface.

## Automated gates

The Docker build runs:

- Python syntax validation for the AionCore patch generator.
- `managed_team_skill_routing_tests`, including Team-wrapper false-positive
  and real-sensitive-task regression coverage.
- The focused DOM test
  `messageTipsManagedSkillRouting.dom.test.tsx`.
- The normal renderer build and managed AionCore release build.

A1 remains pending until the rebuilt image passes the runtime canary.
