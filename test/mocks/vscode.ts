/**
 * VS Code API mocks for testing
 */

// Event Emitter mock
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

// Disposable mock
export class Disposable {
  private disposed = false;

  constructor(private readonly callOnDispose?: () => void) {}

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.callOnDispose?.();
    }
  }

  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
}

// CancellationToken mock
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

export class CancellationTokenSource {
  private _isCancellationRequested = false;
  private readonly emitter = new EventEmitter<void>();
  private readonly _token: CancellationToken;

  constructor() {
    const self = this;
    this._token = {
      get isCancellationRequested() {
        return self._isCancellationRequested;
      },
      onCancellationRequested: (listener: () => void) => {
        return self.emitter.event(listener);
      },
    };
  }

  get token(): CancellationToken {
    return this._token;
  }

  cancel(): void {
    this._isCancellationRequested = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// Message role enum
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

// Language model text part
export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

// Language model tool call part
export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: object
  ) {}
}

// Language model tool result part
export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: unknown[]
  ) {}
}

// Language model chat message
export class LanguageModelChatMessage {
  static User(content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart>, name?: string): LanguageModelChatMessage {
    const parts = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, parts, name);
  }

  static Assistant(content: string | Array<LanguageModelTextPart | LanguageModelToolCallPart>, name?: string): LanguageModelChatMessage {
    const parts = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, parts, name);
  }

  constructor(
    public readonly role: LanguageModelChatMessageRole,
    public readonly content: Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart>,
    public readonly name?: string
  ) {}
}

// Language model chat tool
export interface LanguageModelChatTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Language model chat information
export interface LanguageModelChatInformation {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    toolCalling: boolean;
    imageInput: boolean;
  };
}

// Configuration target enum
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// Configuration change event
export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

// Workspace configuration mock
export class WorkspaceConfiguration {
  private data: Record<string, unknown> = {};

  constructor(initialData?: Record<string, unknown>) {
    this.data = initialData ?? {};
  }

  get<T>(section: string, defaultValue?: T): T {
    return (this.data[section] as T) ?? (defaultValue as T);
  }

  has(section: string): boolean {
    return section in this.data;
  }

  inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T } | undefined {
    return {
      key: section,
      workspaceValue: this.data[section] as T | undefined,
    };
  }

  async update(section: string, value: unknown, _target?: ConfigurationTarget): Promise<void> {
    this.data[section] = value;
  }

  setData(data: Record<string, unknown>): void {
    this.data = data;
  }
}

// Mock workspace namespace
export class MockWorkspace {
  private configurations: Map<string, WorkspaceConfiguration> = new Map();
  private readonly configChangeEmitter = new EventEmitter<ConfigurationChangeEvent>();
  readonly onDidChangeConfiguration = this.configChangeEmitter.event;

  getConfiguration(section?: string): WorkspaceConfiguration {
    const key = section ?? '';
    if (!this.configurations.has(key)) {
      this.configurations.set(key, new WorkspaceConfiguration());
    }
    return this.configurations.get(key)!;
  }

  setConfigurationData(section: string, data: Record<string, unknown>): void {
    const config = this.getConfiguration(section);
    config.setData(data);
  }

  fireConfigurationChange(sections: string[]): void {
    this.configChangeEmitter.fire({
      affectsConfiguration: (section: string) => sections.some((s) => section.startsWith(s) || s.startsWith(section)),
    });
  }
}

// Progress mock
export interface Progress<T> {
  report(value: T): void;
}

export function createProgress<T>(): Progress<T> & { values: T[] } {
  const values: T[] = [];
  return {
    values,
    report(value: T): void {
      values.push(value);
    },
  };
}

// Create the full vscode mock object
export function createVSCodeMock() {
  const workspace = new MockWorkspace();

  return {
    EventEmitter,
    Disposable,
    CancellationTokenSource,
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelChatMessage,
    ConfigurationTarget,
    workspace,
    createProgress,
  };
}

// Export default mock instance
export const vscode = createVSCodeMock();
