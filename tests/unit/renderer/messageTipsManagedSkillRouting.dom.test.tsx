/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === 'conversation.skills.loaded' ? 'Loaded Skills' : (options?.defaultValue ?? key),
  }),
}));

vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@renderer/components/base/ButlerDiagnoseButton', () => ({
  default: () => null,
}));

vi.mock('@renderer/components/base/FeedbackButton', () => ({
  default: () => null,
}));

import type { IMessageTips } from '@/common/chat/chatLib';
import MessageTips, {
  parseManagedSkillRoutingParams,
} from '@/renderer/pages/conversation/Messages/components/MessageTips';

const buildRoutingTip = (params: Record<string, unknown>): IMessageTips =>
  ({
    id: 'routing-tip-1',
    conversation_id: 'conv-1',
    type: 'tips',
    position: 'left',
    status: 'finish',
    content: {
      type: 'info',
      content: 'Loaded skills: ux-heuristics, refactoring-ui',
      code: 'MANAGED_SKILL_ROUTING',
      params,
    },
  }) as IMessageTips;

const A1_PARAMS = {
  task_class: 'ux_audit',
  route: 'design.ux_audit',
  primary: 'ux-heuristics',
  supports: ['refactoring-ui'],
  gates: [],
  loaded_skills: ['ux-heuristics', 'refactoring-ui'],
};

const A2_BACKEND_PARAMS = {
  task_class: 'debug',
  route: 'debug.default',
  primary: 'debug-gate',
  supports: ['test-first-gate'],
  gates: [],
  loaded_skills: ['debug-gate', 'test-first-gate'],
};

const SHIP_ONLY_PARAMS = {
  task_class: 'verification',
  route: 'ship.default',
  primary: 'ship-gate',
  supports: [],
  gates: [],
  loaded_skills: ['ship-gate'],
};

describe('MessageTips — managed skill routing visibility', () => {
  afterEach(() => {
    cleanup();
  });

  it('parses exact per-turn routing metadata', () => {
    expect(parseManagedSkillRoutingParams('MANAGED_SKILL_ROUTING', A1_PARAMS)).toEqual({
      taskClass: 'ux_audit',
      route: 'design.ux_audit',
      primary: 'ux-heuristics',
      supports: ['refactoring-ui'],
      gates: [],
      loadedSkills: ['ux-heuristics', 'refactoring-ui'],
    });
  });

  it('renders the A1 primary and support without a gate', () => {
    render(<MessageTips message={buildRoutingTip(A1_PARAMS)} />);

    expect(screen.getByTestId('managed-skill-routing')).toBeInTheDocument();
    expect(screen.getByTestId('managed-skill-routing-count')).toHaveTextContent('Loaded Skills (2)');
    expect(screen.getByTestId('managed-skill-routing-route')).toHaveTextContent('design.ux_audit');
    expect(screen.getByTestId('managed-skill-routing-primary')).toHaveTextContent('Primary · ux-heuristics');
    expect(screen.getByTestId('managed-skill-routing-support')).toHaveTextContent('Support · refactoring-ui');
    expect(screen.getByTestId('managed-skill-routing-task-class')).toHaveTextContent('ux_audit');
    expect(screen.queryByTestId('managed-skill-routing-gate')).not.toBeInTheDocument();
  });

  it('renders the A2 Backend route without requiring skill-design', () => {
    render(<MessageTips message={buildRoutingTip(A2_BACKEND_PARAMS)} />);

    expect(screen.getByTestId('managed-skill-routing')).toBeInTheDocument();
    expect(screen.getByTestId('managed-skill-routing-count')).toHaveTextContent('Loaded Skills (2)');
    expect(screen.getByTestId('managed-skill-routing-route')).toHaveTextContent('debug.default');
    expect(screen.getByTestId('managed-skill-routing-primary')).toHaveTextContent('Primary · debug-gate');
    expect(screen.getByTestId('managed-skill-routing-support')).toHaveTextContent('Support · test-first-gate');
    expect(screen.getByTestId('managed-skill-routing-task-class')).toHaveTextContent('debug');
    expect(screen.queryByTestId('managed-skill-routing-gate')).not.toBeInTheDocument();
  });

  it('renders ship-only roles without inventing support skills or gates', () => {
    render(<MessageTips message={buildRoutingTip(SHIP_ONLY_PARAMS)} />);

    expect(screen.getByTestId('managed-skill-routing-count')).toHaveTextContent('Loaded Skills (1)');
    expect(screen.getByTestId('managed-skill-routing-route')).toHaveTextContent('ship.default');
    expect(screen.getByTestId('managed-skill-routing-primary')).toHaveTextContent('Primary · ship-gate');
    expect(screen.queryByTestId('managed-skill-routing-support')).not.toBeInTheDocument();
    expect(screen.queryByTestId('managed-skill-routing-gate')).not.toBeInTheDocument();
  });

  it('shows mandatory gates and counts them as loaded skills', () => {
    render(
      <MessageTips
        message={buildRoutingTip({
          ...A1_PARAMS,
          gates: ['security-gate'],
          loaded_skills: ['ux-heuristics', 'refactoring-ui', 'security-gate'],
        })}
      />
    );

    expect(screen.getByTestId('managed-skill-routing-count')).toHaveTextContent('Loaded Skills (3)');
    expect(screen.getByTestId('managed-skill-routing-gate')).toHaveTextContent('Gate · security-gate');
  });

  it('falls back to the ordinary info tip when routing metadata is malformed', () => {
    render(
      <MessageTips
        message={buildRoutingTip({
          task_class: 'ux_audit',
          supports: ['refactoring-ui'],
        })}
      />
    );

    expect(screen.queryByTestId('managed-skill-routing')).not.toBeInTheDocument();
    expect(screen.getByText('Loaded skills: ux-heuristics, refactoring-ui')).toBeInTheDocument();
  });
});
