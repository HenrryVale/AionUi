# Managed Skill Routing Visibility

## Scope

This change closes the A1 Frontend routing false-positive and makes the managed
skills selected and injected for each Team turn visible in the chat UI.

It does **not** change the role allowlists, the pinned `router.yaml`, or the
security-gate vocabulary. It changes the provenance of task intent used by the
router and adds user-visible audit metadata for the route actually selected.

## Problem

A Team turn has two conceptually different inputs:

1. The model-visible Team prompt: governance, role, tools, mailbox summary and
   task-board context.
2. The semantic task intent that should drive managed-skill routing.

FIX-2B routed on the whole `SendMessageData.content`. Team Governance contains
words such as `permission`, `authorization`, `secret`, and `password`, so a
read-only UX audit incorrectly selected `security-gate`.

Parsing the human-readable Team prompt to recover task intent was considered and
rejected before build validation. That format is deliberately readable, so a
user message could contain strings resembling Team headings or mailbox
delimiters. Security-gate selection must not depend on parsing an ambiguous
rendered prompt.

The existing conversation skills indicator is also a different concept: it
shows the skills mounted on the conversation snapshot, not the subset selected
for one turn.

## Design

### Structured semantic routing intent

The Team layer already owns the structured mailbox and task data, so it is the
source of truth for routing intent.

For non-command Team turns it derives `routing_content` from:

1. the latest non-empty structured `MailboxMessageType::Message`; otherwise
2. the newest active task owned by the target slot, using subject plus
   description.

That value is carried as metadata through:

`WakeInput -> AgentTurnRequest -> ConversationAgentTurnRequest -> TurnStartInput
-> SendMessageData.routing_content`.

The model-visible `content` is not rewritten and still contains Team
Governance, role instructions and wake context. Managed routing reads
`routing_content`, not that rendered prompt.

A non-command Team turn with no semantic task carries `Some("")`, which keeps
the existing fail-closed classifier behavior instead of falling back to
Governance text.

Native slash commands are an explicit exception. They carry
`routing_content = None`, bypass managed task routing and preserve the existing
byte-identical command-dispatch path. Ordinary non-Team callers also use
`None`, but they do not have a managed Team routing context.

System-response continuations preserve the original routing metadata so a
continuation cannot silently choose a new skill route from generated text.

### Gate behavior

Route classification and mandatory-gate detection use the same structured
semantic task string.

For A1:

- Team Governance containing `permission`, `secret`, etc. does not influence
  gate selection.
- The read-only UX request produces no gate.
- A real user task that itself mentions a sensitive surface such as
  `password` still selects `security-gate`.

The sensitive vocabulary is intentionally unchanged.

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
The existing stream relay already forwards and persists informational tips, so
the routing card is visible live and after conversation reload without a new
database schema or a new message type.

The fallback text says **Loaded skills** rather than **Used skills** because the
metadata proves which skill bodies were selected and injected into model input;
it does not overclaim that a failed provider dispatch consumed them.

### Chat UI

`MessageTips` recognizes `MANAGED_SKILL_ROUTING` and renders a compact card
showing:

- loaded skill count,
- route,
- primary skill,
- support skills,
- mandatory gates when present,
- task class.

The existing conversation-level skills indicator remains unchanged and continues
to represent the mounted conversation snapshot.

## Validation plan

A1 acceptance after rebuilding the image requires all of the following:

- Frontend role skill view remains exactly 16 / 16 / 16.
- The Team model prompt still contains Governance and the original wake payload.
- Structured `routing_content` for A1 is exactly the real UX request.
- The read-only UX audit routes to `design.ux_audit`.
- Primary is `ux-heuristics`.
- Support is `refactoring-ui`.
- Gates are empty.
- A real sensitive semantic task still selects `security-gate`.
- Native slash-command turns preserve their bare-command path and have no
  managed routing metadata.
- The transcript contains the managed routing preamble and selected skill
  bodies.
- The chat shows the managed-skill routing card.
- Reloading the conversation preserves the same card.
- No out-of-allowlist skills appear in the effective Frontend runtime surface.

## Automated gates

The Docker build runs:

- Python syntax validation for the AionCore patch generator.
- Existing managed skill security, role-mode, direct-CLI delivery,
  router-bootstrap and routing tests.
- Team integration coverage proving semantic routing propagation for direct user
  and teammate turns.
- Team native slash-command coverage proving routing bypass.
- The focused DOM test
  `messageTipsManagedSkillRouting.dom.test.tsx`.
- The normal renderer build and managed AionCore release build.

A1 passed the rebuilt runtime canary: exact Frontend identity, 16/16/16 skill view, exact managed 16-skill surface, no auto-skill leaks, `design.ux_audit` with `ux-heuristics` + `refactoring-ui`, `gates=[]`, visible `Loaded Skills (2)`, and an unchanged workspace.


## A2 Backend discovery

A1 originally validated only the Frontend role. Runtime testing of the next role
exposed a role-activation gap: Backend completed a task but emitted no
`MANAGED_SKILL_ROUTING` card.

Repository inspection showed that managed routing activation was accidentally
coupled to the role having `skill-design` in its allowlist:

- the direct-CLI bootstrap ran only when `config.skills` contained
  `skill-design`;
- the routing context then required the bootstrap marker and a resolved
  `skill-design` source;
- Frontend and Full Stack include `skill-design`, but Backend, QA, Security,
  Reviewer, Architect, PM and DevOps deliberately do not.

Therefore the behavior was systemic rather than Backend-specific: those roles
could receive their fixed skill catalog yet never create the deterministic
per-turn routing context or the Loaded Skills card.

The fix keeps the exact role catalogs unchanged. `skill-design` remains a
Frontend/Full Stack capability rather than being added to every role. Managed
role assistants now persist a machine-readable
`[Managed Team Role Routing v1]` rule marker. AionCore activates deterministic
routing from that marker and derives the managed bundle root from the role's
resolved skill sources, while still enforcing the role allowlist. Frontend may
continue to receive the full `skill-design` bootstrap body, but routing no
longer depends on that capability being present.

A regression test covers a Backend allowlist with only
`debug-gate`, `test-first-gate`, `security-gate`,
`prompt-injection-gate` and `ship-gate`. The A2 read-only debug task must
route to `debug.default`, load `debug-gate` plus
`test-first-gate`, add no gate, and contain no `skill-design` body.

The image build also runs the Team role provisioning unit test so the
machine-readable marker cannot silently disappear while the renderer routing
card test continues to pass.

A2 Backend remains pending until the marker-based routing change is rebuilt and proven in a fresh runtime canary. The power-loss interrupted runtime log collection; the repository-level activation defect is independently demonstrated by source inspection and regression coverage, but the fix is not yet claimed as runtime PASS.
