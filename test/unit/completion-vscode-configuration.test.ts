import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  effective: {} as Record<string, unknown>,
  inspected: {} as Record<
    string,
    | {
        readonly defaultValue?: unknown;
        readonly workspaceFolderValue?: unknown;
        readonly workspaceValue?: unknown;
        readonly globalValue?: unknown;
      }
    | undefined
  >,
  updates: [] as {
    readonly key: string;
    readonly value: unknown;
    readonly target: number;
  }[],
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => state.effective[key],
      inspect: (key: string) => state.inspected[key],
      update: async (key: string, value: unknown, target: number) => {
        state.updates.push({ key, value, target });
      },
    }),
  },
}));

import {
  clearCompletionConfiguration,
  readScopedCompletionConfiguration,
  updateCompletionConfiguration,
} from '../../src/completion/vscode-configuration';
import { DEFAULT_COMPLETION_DISABLED_GLOBS } from '../../src/completion/disabled-globs';
import * as vscodeApi from 'vscode';

beforeEach(() => {
  state.effective = {};
  state.inspected = {};
  state.updates = [];
});

describe('scoped completion configuration', () => {
  it('reads only explicit global values without workspace inheritance', () => {
    state.effective = {
      enabled: false,
      providers: [{ id: 'effective', algorithm: 'simple' }],
      strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
    };
    state.inspected = {
      enabled: { globalValue: true, workspaceValue: false },
      providers: {
        globalValue: [{ id: 'global', algorithm: 'simple' }],
        workspaceValue: [
          { id: 'workspace', algorithm: 'copilot-replica' },
        ],
      },
      strategy: {
        globalValue: {
          mode: 'main-first',
          disableVSCodeBuiltinCompletion: false,
          mainProvider: 'global',
          stopWhen: { type: 'allSettled' },
        },
        workspaceValue: {
          mode: 'all',
          stopWhen: { type: 'firstUsable', graceMs: 10 },
        },
      },
    };

    expect(
      readScopedCompletionConfiguration(vscodeApi.ConfigurationTarget.Global),
    ).toEqual({
      configuration: {
        enabled: true,
        providers: [{ id: 'global', algorithm: 'simple' }],
        strategy: {
          mode: 'main-first',
          disableVSCodeBuiltinCompletion: false,
          disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
          mainProvider: 'global',
          stopWhen: { type: 'allSettled' },
        },
      },
      issues: [],
      explicit: { enabled: true, strategy: true },
    });
  });

  it('reads only explicit workspace values without global inheritance', () => {
    state.inspected = {
      enabled: { defaultValue: true, globalValue: true, workspaceValue: false },
      providers: {
        defaultValue: [],
        globalValue: [{ id: 'global', algorithm: 'simple' }],
        workspaceValue: [
          { id: 'workspace', algorithm: 'copilot-replica' },
        ],
      },
      strategy: {
        defaultValue: {
          mode: 'all',
          stopWhen: { type: 'firstUsable', graceMs: 0 },
        },
        globalValue: { mode: 'all', stopWhen: { type: 'allSettled' } },
      },
    };

    expect(
      readScopedCompletionConfiguration(
        vscodeApi.ConfigurationTarget.Workspace,
      ),
    ).toEqual({
      configuration: {
        enabled: false,
        providers: [
          { id: 'workspace', algorithm: 'copilot-replica' },
        ],
        strategy: {
          mode: 'all',
          disableVSCodeBuiltinCompletion: true,
          disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
          stopWhen: { type: 'firstUsable', graceMs: 0 },
        },
      },
      issues: [],
      explicit: { enabled: true, strategy: false },
    });
  });

  it('normalizes an absent scoped value without marking defaults explicit', () => {
    state.effective = {
      enabled: false,
      providers: [{ id: 'inherited', algorithm: 'simple' }],
      strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
    };

    expect(
      readScopedCompletionConfiguration(
        vscodeApi.ConfigurationTarget.Workspace,
      ),
    ).toEqual({
      configuration: {
        enabled: true,
        providers: [],
        strategy: {
          mode: 'all',
          disableVSCodeBuiltinCompletion: true,
          disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
          stopWhen: { type: 'firstUsable', graceMs: 0 },
        },
      },
      issues: [],
      explicit: { enabled: false, strategy: false },
    });
  });

  it('updates a value at the requested scope', async () => {
    const providers = [{ id: 'simple', algorithm: 'simple' }];

    await updateCompletionConfiguration(
      'providers',
      providers,
      vscodeApi.ConfigurationTarget.Workspace,
    );

    expect(state.updates).toEqual([
      {
        key: 'providers',
        value: providers,
        target: vscodeApi.ConfigurationTarget.Workspace,
      },
    ]);
  });

  it('clears a value only at the requested scope', async () => {
    await clearCompletionConfiguration(
      'strategy',
      vscodeApi.ConfigurationTarget.Global,
    );

    expect(state.updates).toEqual([
      {
        key: 'strategy',
        value: undefined,
        target: vscodeApi.ConfigurationTarget.Global,
      },
    ]);
  });
});
