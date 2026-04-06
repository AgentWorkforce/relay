// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { DocsLanguageProvider } from '../../components/docs/DocsLanguageContext';
import { SpawnOptionsTable } from '../../components/docs/SpawnOptionsTable';

describe('SpawnOptionsTable', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows relay startup TypeScript option names by default', () => {
    render(
      <DocsLanguageProvider>
        <SpawnOptionsTable variant="relay-startup" />
      </DocsLanguageProvider>
    );

    expect(screen.getByText('binaryPath')).toBeInTheDocument();
    expect(screen.getByText('binaryArgs')).toBeInTheDocument();
    expect(screen.getByText('brokerName')).toBeInTheDocument();
    expect(screen.getByText('onStderr')).toBeInTheDocument();
    expect(screen.getByText('startupTimeoutMs')).toBeInTheDocument();
    expect(screen.getByText('requestTimeoutMs')).toBeInTheDocument();
    expect(
      screen.getByText('Extra args passed to `broker init` (for example `{ persist: true }`).')
    ).toBeInTheDocument();
    expect(screen.queryByText('binary_path')).not.toBeInTheDocument();
  });

  it('shows TypeScript option names by default', () => {
    render(
      <DocsLanguageProvider>
        <SpawnOptionsTable variant="common" />
      </DocsLanguageProvider>
    );

    expect(screen.getByText('skipRelayPrompt')).toBeInTheDocument();
    expect(screen.getByText('onStart')).toBeInTheDocument();
    expect(screen.getByText('onSuccess')).toBeInTheDocument();
    expect(screen.getByText('onError')).toBeInTheDocument();
    expect(screen.queryByText('skip_relay_prompt')).not.toBeInTheDocument();
  });

  it('shows Python option names when python is the selected docs language', async () => {
    window.localStorage.setItem('agent-relay-docs-language', 'python');

    render(
      <DocsLanguageProvider>
        <SpawnOptionsTable variant="common" />
      </DocsLanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('skip_relay_prompt')).toBeInTheDocument();
    });

    expect(screen.getByText('on_start')).toBeInTheDocument();
    expect(screen.getByText('on_success')).toBeInTheDocument();
    expect(screen.getByText('on_error')).toBeInTheDocument();
    expect(screen.queryByText('skipRelayPrompt')).not.toBeInTheDocument();
  });

  it('shows relay startup Python option names when python is the selected docs language', async () => {
    window.localStorage.setItem('agent-relay-docs-language', 'python');

    render(
      <DocsLanguageProvider>
        <SpawnOptionsTable variant="relay-startup" />
      </DocsLanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('binary_path')).toBeInTheDocument();
    });

    expect(screen.getByText('binary_args')).toBeInTheDocument();
    expect(screen.getByText('broker_name')).toBeInTheDocument();
    expect(screen.getByText('on_stderr')).toBeInTheDocument();
    expect(screen.getByText('startup_timeout_ms')).toBeInTheDocument();
    expect(screen.getByText('request_timeout_ms')).toBeInTheDocument();
    expect(
      screen.getByText('Extra args passed to `broker init` (for example `["--persist"]`).')
    ).toBeInTheDocument();
    expect(screen.queryByText('binaryPath')).not.toBeInTheDocument();
  });
});
