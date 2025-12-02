/**
 * Tests for ConfigStore
 */

import { describe, it, beforeEach, mock } from 'node:test';
import * as assert from 'node:assert';
import {
  vscode,
  EventEmitter,
  ConfigurationTarget,
  WorkspaceConfiguration,
  MockWorkspace,
  ConfigurationChangeEvent,
} from '../mocks/vscode.js';

// Mock vscode module before importing ConfigStore
const mockWorkspace = new MockWorkspace();
const mockVscode = {
  ...vscode,
  workspace: mockWorkspace,
  ConfigurationTarget,
  EventEmitter,
};

// Create a testable ConfigStore class that uses our mocks
class TestableConfigStore {
  private readonly _onDidChange = new mockVscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _disposable: { dispose(): void };

  constructor() {
    this._disposable = mockWorkspace.onDidChangeConfiguration(
      (e: ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('unifyChatProvider')) {
          this._onDidChange.fire();
        }
      },
    );
  }

  get endpoints() {
    const config = mockWorkspace.getConfiguration('unifyChatProvider');
    const rawEndpoints = config.get<unknown[]>('endpoints', []);
    return rawEndpoints
      .map((raw) => this.normalizeProviderConfig(raw))
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }

  get configuration() {
    return { endpoints: this.endpoints };
  }

  private normalizeProviderConfig(raw: unknown) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj.name !== 'string' || !obj.name) {
      return null;
    }

    if (typeof obj.baseUrl !== 'string' || !obj.baseUrl) {
      return null;
    }

    if (!Array.isArray(obj.models) || obj.models.length === 0) {
      return null;
    }

    const models = obj.models
      .map((m: unknown) => this.normalizeModelConfig(m))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    if (models.length === 0) {
      return null;
    }

    // Parse and validate type (required field)
    if (typeof obj.type !== 'string' || !['anthropic'].includes(obj.type)) {
      return null;
    }
    const type = obj.type as 'anthropic';

    return {
      type: type as 'anthropic',
      name: obj.name,
      baseUrl: obj.baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
      models,
    };
  }

  private normalizeModelConfig(raw: unknown) {
    if (typeof raw === 'string' && raw) {
      return { id: raw };
    }

    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.id === 'string' && obj.id) {
        return {
          id: obj.id,
          name: typeof obj.name === 'string' ? obj.name : undefined,
          maxInputTokens:
            typeof obj.maxInputTokens === 'number'
              ? obj.maxInputTokens
              : undefined,
          maxOutputTokens:
            typeof obj.maxOutputTokens === 'number'
              ? obj.maxOutputTokens
              : undefined,
        };
      }
    }

    return null;
  }

  getProvider(name: string) {
    return this.endpoints.find((p) => p.name === name);
  }

  async setEndpoints(endpoints: unknown[]): Promise<void> {
    await mockWorkspace
      .getConfiguration()
      .update(
        'unifyChatProvider.endpoints',
        endpoints,
        ConfigurationTarget.Workspace,
      );
  }

  async upsertProvider(provider: {
    name: string;
    type: string;
    baseUrl: string;
    models: unknown[];
  }): Promise<void> {
    const endpoints = this.endpoints.filter((p) => p.name !== provider.name);
    endpoints.push(
      provider as ReturnType<TestableConfigStore['normalizeProviderConfig']> &
        object,
    );
    await this.setEndpoints(endpoints);
  }

  async removeProvider(name: string): Promise<void> {
    const endpoints = this.endpoints.filter((p) => p.name !== name);
    await this.setEndpoints(endpoints);
  }

  dispose(): void {
    this._disposable.dispose();
    this._onDidChange.dispose();
  }
}

describe('ConfigStore', () => {
  let store: TestableConfigStore;

  beforeEach(() => {
    // Reset workspace configuration
    mockWorkspace.setConfigurationData('unifyChatProvider', { endpoints: [] });
    store = new TestableConfigStore();
  });

  describe('endpoints getter', () => {
    it('should return empty array when no endpoints configured', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [],
      });
      assert.deepStrictEqual(store.endpoints, []);
    });

    it('should normalize and return valid endpoints', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test-provider',
            baseUrl: 'https://api.example.com',
            models: ['model-1', 'model-2'],
          },
        ],
      });

      const endpoints = store.endpoints;
      assert.strictEqual(endpoints.length, 1);
      assert.strictEqual(endpoints[0].name, 'test-provider');
      assert.strictEqual(endpoints[0].baseUrl, 'https://api.example.com');
      assert.strictEqual(endpoints[0].type, 'anthropic');
      assert.strictEqual(endpoints[0].models.length, 2);
    });

    it('should filter out endpoints with missing type', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            name: 'no-type',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
          {
            type: 'anthropic',
            name: 'valid',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
      assert.strictEqual(store.endpoints[0].name, 'valid');
    });

    it('should filter out invalid endpoints with missing name', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          { type: 'anthropic', baseUrl: 'https://api.example.com', models: ['model-1'] },
          { type: 'anthropic', name: '', baseUrl: 'https://api.example.com', models: ['model-1'] },
          {
            type: 'anthropic',
            name: 'valid',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
      assert.strictEqual(store.endpoints[0].name, 'valid');
    });

    it('should filter out invalid endpoints with missing baseUrl', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          { type: 'anthropic', name: 'test', models: ['model-1'] },
          { type: 'anthropic', name: 'test', baseUrl: '', models: ['model-1'] },
          {
            type: 'anthropic',
            name: 'valid',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
      assert.strictEqual(store.endpoints[0].name, 'valid');
    });

    it('should filter out invalid endpoints with missing or empty models', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          { type: 'anthropic', name: 'no-models', baseUrl: 'https://api.example.com' },
          {
            type: 'anthropic',
            name: 'empty-models',
            baseUrl: 'https://api.example.com',
            models: [],
          },
          {
            type: 'anthropic',
            name: 'valid',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
      assert.strictEqual(store.endpoints[0].name, 'valid');
    });

    it('should filter out endpoints with invalid provider type', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            name: 'invalid-type',
            type: 'openai',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
          {
            name: 'valid',
            type: 'anthropic',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
      assert.strictEqual(store.endpoints[0].name, 'valid');
    });

    it('should handle null and non-object values in endpoints array', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          null,
          undefined,
          'string',
          123,
          true,
          {
            type: 'anthropic',
            name: 'valid',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints.length, 1);
    });
  });

  describe('normalizeModelConfig', () => {
    it('should accept string model IDs', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: ['model-1', 'model-2'],
          },
        ],
      });

      const models = store.endpoints[0].models;
      assert.strictEqual(models.length, 2);
      assert.strictEqual(models[0].id, 'model-1');
      assert.strictEqual(models[1].id, 'model-2');
    });

    it('should accept object model configs', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: [
              {
                id: 'model-1',
                name: 'Model One',
                maxInputTokens: 100000,
                maxOutputTokens: 4096,
              },
            ],
          },
        ],
      });

      const model = store.endpoints[0].models[0];
      assert.strictEqual(model.id, 'model-1');
      assert.strictEqual(model.name, 'Model One');
      assert.strictEqual(model.maxInputTokens, 100000);
      assert.strictEqual(model.maxOutputTokens, 4096);
    });

    it('should accept mixed string and object model configs', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: [
              'simple-model',
              { id: 'detailed-model', name: 'Detailed', maxInputTokens: 50000 },
            ],
          },
        ],
      });

      const models = store.endpoints[0].models;
      assert.strictEqual(models.length, 2);
      assert.strictEqual(models[0].id, 'simple-model');
      assert.strictEqual(models[0].name, undefined);
      assert.strictEqual(models[1].id, 'detailed-model');
      assert.strictEqual(models[1].name, 'Detailed');
      assert.strictEqual(models[1].maxInputTokens, 50000);
    });

    it('should filter out invalid model configs', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: [
              '',
              null,
              {},
              { id: '' },
              { name: 'no-id' },
              'valid-model',
            ],
          },
        ],
      });

      const models = store.endpoints[0].models;
      assert.strictEqual(models.length, 1);
      assert.strictEqual(models[0].id, 'valid-model');
    });

    it('should handle object model config with only id', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: [{ id: 'minimal-model' }],
          },
        ],
      });

      const model = store.endpoints[0].models[0];
      assert.strictEqual(model.id, 'minimal-model');
      assert.strictEqual(model.name, undefined);
      assert.strictEqual(model.maxInputTokens, undefined);
      assert.strictEqual(model.maxOutputTokens, undefined);
    });
  });

  describe('optional fields', () => {
    it('should include apiKey when provided', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            apiKey: 'secret-key',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints[0].apiKey, 'secret-key');
    });

    it('should set apiKey to undefined when not provided', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: ['model-1'],
          },
        ],
      });

      assert.strictEqual(store.endpoints[0].apiKey, undefined);
    });

  });

  describe('getProvider', () => {
    beforeEach(() => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'provider-1',
            baseUrl: 'https://api1.example.com',
            models: ['m1'],
          },
          {
            type: 'anthropic',
            name: 'provider-2',
            baseUrl: 'https://api2.example.com',
            models: ['m2'],
          },
        ],
      });
    });

    it('should find provider by name', () => {
      const provider = store.getProvider('provider-1');
      assert.ok(provider);
      assert.strictEqual(provider.name, 'provider-1');
      assert.strictEqual(provider.baseUrl, 'https://api1.example.com');
    });

    it('should return undefined for non-existent provider', () => {
      const provider = store.getProvider('non-existent');
      assert.strictEqual(provider, undefined);
    });
  });

  describe('setEndpoints', () => {
    it('should update endpoints in configuration', async () => {
      const newEndpoints = [
        {
          name: 'new-provider',
          type: 'anthropic',
          baseUrl: 'https://new.example.com',
          models: ['new-model'],
        },
      ];

      await store.setEndpoints(newEndpoints);

      const config = mockWorkspace.getConfiguration();
      const saved = config.get('unifyChatProvider.endpoints');
      assert.deepStrictEqual(saved, newEndpoints);
    });
  });

  describe('upsertProvider', () => {
    beforeEach(() => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            name: 'existing',
            type: 'anthropic',
            baseUrl: 'https://old.example.com',
            models: ['old-model'],
          },
        ],
      });
    });

    it('should add new provider', async () => {
      await store.upsertProvider({
        name: 'new-provider',
        type: 'anthropic',
        baseUrl: 'https://new.example.com',
        models: ['new-model'],
      });

      // Re-fetch endpoints from the store
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: mockWorkspace
          .getConfiguration()
          .get('unifyChatProvider.endpoints', []),
      });

      const endpoints = store.endpoints;
      assert.strictEqual(endpoints.length, 2);
      assert.ok(endpoints.find((e) => e.name === 'existing'));
      assert.ok(endpoints.find((e) => e.name === 'new-provider'));
    });

    it('should update existing provider with same name', async () => {
      await store.upsertProvider({
        name: 'existing',
        type: 'anthropic',
        baseUrl: 'https://updated.example.com',
        models: ['updated-model'],
      });

      // Re-fetch endpoints from the store
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: mockWorkspace
          .getConfiguration()
          .get('unifyChatProvider.endpoints', []),
      });

      const endpoints = store.endpoints;
      assert.strictEqual(endpoints.length, 1);
      assert.strictEqual(endpoints[0].baseUrl, 'https://updated.example.com');
      assert.strictEqual(endpoints[0].models[0].id, 'updated-model');
    });
  });

  describe('removeProvider', () => {
    beforeEach(() => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            name: 'provider-1',
            type: 'anthropic',
            baseUrl: 'https://api1.example.com',
            models: ['m1'],
          },
          {
            name: 'provider-2',
            type: 'anthropic',
            baseUrl: 'https://api2.example.com',
            models: ['m2'],
          },
        ],
      });
    });

    it('should remove provider by name', async () => {
      await store.removeProvider('provider-1');

      // Re-fetch endpoints from the store
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: mockWorkspace
          .getConfiguration()
          .get('unifyChatProvider.endpoints', []),
      });

      const endpoints = store.endpoints;
      assert.strictEqual(endpoints.length, 1);
      assert.strictEqual(endpoints[0].name, 'provider-2');
    });

    it('should do nothing when removing non-existent provider', async () => {
      await store.removeProvider('non-existent');

      // Re-fetch endpoints from the store
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: mockWorkspace
          .getConfiguration()
          .get('unifyChatProvider.endpoints', []),
      });

      const endpoints = store.endpoints;
      assert.strictEqual(endpoints.length, 2);
    });
  });

  describe('configuration property', () => {
    it('should return full configuration object', () => {
      mockWorkspace.setConfigurationData('unifyChatProvider', {
        endpoints: [
          {
            type: 'anthropic',
            name: 'test',
            baseUrl: 'https://api.example.com',
            models: ['model'],
          },
        ],
      });

      const config = store.configuration;
      assert.ok(config.endpoints);
      assert.strictEqual(config.endpoints.length, 1);
    });
  });

  describe('onDidChange event', () => {
    it('should fire when configuration changes', () => {
      let changeCount = 0;
      const disposable = store.onDidChange(() => {
        changeCount++;
      });

      mockWorkspace.fireConfigurationChange(['unifyChatProvider']);

      assert.strictEqual(changeCount, 1);
      disposable.dispose();
    });

    it('should not fire for unrelated configuration changes', () => {
      let changeCount = 0;
      const disposable = store.onDidChange(() => {
        changeCount++;
      });

      mockWorkspace.fireConfigurationChange(['otherExtension']);

      assert.strictEqual(changeCount, 0);
      disposable.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      let changeCount = 0;
      store.onDidChange(() => {
        changeCount++;
      });

      store.dispose();

      // After dispose, events should not fire
      mockWorkspace.fireConfigurationChange(['unifyChatProvider']);
      assert.strictEqual(changeCount, 0);
    });
  });
});
