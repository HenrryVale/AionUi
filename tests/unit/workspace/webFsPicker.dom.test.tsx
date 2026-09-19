/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { systemInfo: { invoke: vi.fn().mockResolvedValue({ workDir: '/' }) } },
    fs: { getFilesByDir: { invoke: vi.fn().mockResolvedValue([]) } },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

import { WebFsPicker } from '@/renderer/components/workspace/webFsPicker';

afterEach(() => cleanup());

/**
 * Stacking of the modal the picker is launched from. Mirrors the values in
 * packages/desktop/src/renderer/pages/team/components/TeamCreateModal.tsx —
 * the picker is opened from New Team → Workspace → Select folder, so it has to
 * clear this layer or it renders behind its own opener.
 */
const PARENT_MODAL_WRAP_Z_INDEX = 10000;
const PARENT_MODAL_MASK_Z_INDEX = 9999;

const renderPicker = async () => {
  render(<WebFsPicker options={{ properties: ['openDirectory'] }} onDone={vi.fn()} />);
  const dialog = await screen.findByRole('dialog');
  return {
    dialog,
    modal: dialog.closest<HTMLElement>('.arco-modal'),
    wrapper: dialog.closest<HTMLElement>('.arco-modal-wrapper'),
    mask: document.querySelector<HTMLElement>('.arco-modal-mask'),
  };
};

describe('WebFsPicker responsive dialog', () => {
  it('keeps the picker inside a narrow WebUI viewport', async () => {
    const { modal } = await renderPicker();

    expect(modal?.style.width).toBe('calc(100vw - 32px)');
    expect(modal?.style.maxWidth).toBe('640px');
  });
});

describe('WebFsPicker stacking above the modal that opened it', () => {
  it('renders its wrapper above the parent modal wrapper', async () => {
    const { wrapper } = await renderPicker();

    expect(wrapper).not.toBeNull();
    expect(Number(wrapper?.style.zIndex)).toBeGreaterThan(PARENT_MODAL_WRAP_Z_INDEX);
  });

  it('renders its mask above the parent modal mask', async () => {
    const { mask } = await renderPicker();

    expect(mask).not.toBeNull();
    expect(Number(mask?.style.zIndex)).toBeGreaterThan(PARENT_MODAL_MASK_Z_INDEX);
  });

  it('keeps its own dialog above its own mask', async () => {
    const { wrapper, mask } = await renderPicker();

    expect(Number(wrapper?.style.zIndex)).toBeGreaterThan(Number(mask?.style.zIndex));
  });

  it('stays reachable as a dialog for assistive technology', async () => {
    const { dialog } = await renderPicker();

    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
  });
});
