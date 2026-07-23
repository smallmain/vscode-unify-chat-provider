import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type * as vscode from "vscode";
import type {
  JointCancellationSignal,
  JointClock,
} from "../../src/chat-lib/core/joint/types";
import type {
  NesDocumentContext,
  NesPromptContext,
} from "../../src/chat-lib/core/nes/types";
import type {
  TriggerClock,
  TriggerTimeout,
} from "../../src/chat-lib/core/nes/triggerer";

interface ParityCaseMetadata {
  readonly id: string;
  readonly assertion: string;
}

export interface ParityCasePart {
  readonly assertion: string;
  run(): void | Promise<void>;
}

export type ParityCase = ParityCaseMetadata &
  (
    | { run(): void | Promise<void> }
    | { readonly parts: readonly ParityCasePart[] }
  );

interface BehaviorMatrix {
  readonly upstream: {
    readonly repository: string;
    readonly ref: string;
    readonly commit: string;
  };
  readonly rows: readonly {
    readonly id: string;
    readonly category: string;
    readonly observable: string;
    readonly sourcePath: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly anchor: string;
  }[];
}

interface CompletionInput {
  readonly clock: {
    readonly requestIssuedDateTime: number;
    readonly earliestShownDateTime: number;
  };
  readonly document: {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    readonly text: string;
    readonly position: { readonly line: number; readonly character: number };
  };
  readonly history: readonly {
    readonly uri: string;
    readonly before: string;
    readonly after: string;
    readonly timestamp: number;
  }[];
  readonly contextFiles: readonly {
    readonly uri: string;
    readonly text: string;
  }[];
  readonly diagnostics: readonly {
    readonly message: string;
    readonly severity: "error" | "warning" | "information" | "hint";
    readonly line: number;
  }[];
  readonly modelOutputs: Readonly<{
    fim: readonly string[];
    copilotNesXtab: readonly string[];
    xtab275: readonly string[];
    xtabUnifiedModel: readonly string[];
  }>;
}

interface CompletionEffectsFixture {
  readonly schemaVersion: 1;
  readonly upstream: {
    readonly repository: string;
    readonly ref: string;
    readonly commit: string;
  };
  readonly effects: Readonly<Record<string, unknown>>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(relativePath, "utf8")) as T;
}

export const behaviorMatrix = readJson<BehaviorMatrix>(
  "test/parity/behavior-matrix.json",
);

export const completionEffects = readJson<CompletionEffectsFixture>(
  "test/parity/fixtures/completion-effects.json",
);

export const completionInput = readJson<CompletionInput>(
  "test/parity/completion-input.json",
);

export function expectedFor<T>(id: string): T {
  if (!Object.prototype.hasOwnProperty.call(completionEffects.effects, id)) {
    throw new Error(`Missing completion-effect baseline for ${id}.`);
  }
  return completionEffects.effects[id] as T;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolvePromise) throw new Error("Deferred resolve is unavailable.");
      resolvePromise(value);
    },
    reject(error): void {
      if (!rejectPromise) throw new Error("Deferred reject is unavailable.");
      rejectPromise(error);
    },
  };
}

export async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

export function chunks(values: readonly string[]): AsyncIterable<string> {
  return (async function* (): AsyncIterable<string> {
    for (const value of values) {
      yield value;
    }
  })();
}

export function sequenceId(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

export function offsetAtPosition(
  text: string,
  position: { readonly line: number; readonly character: number },
): number {
  const lines = text.split("\n");
  if (position.line < 0 || position.line >= lines.length) {
    throw new Error("Position line is outside the document.");
  }
  if (
    position.character < 0 ||
    position.character > lines[position.line].length
  ) {
    throw new Error("Position character is outside the document.");
  }
  return (
    lines
      .slice(0, position.line)
      .reduce((sum, line) => sum + line.length + 1, 0) + position.character
  );
}

export function makeNesPromptContext(): NesPromptContext {
  const input = completionInput;
  const current: NesDocumentContext = {
    uri: input.document.uri,
    path: "/workspace/src/counter.ts",
    relativePath: "src/counter.ts",
    languageId: input.document.languageId,
    version: input.document.version,
    text: input.document.text,
    workspaceRoot: "/workspace",
    selection: {
      start: offsetAtPosition(input.document.text, input.document.position),
      end: offsetAtPosition(input.document.text, input.document.position),
      active: offsetAtPosition(input.document.text, input.document.position),
    },
    visibleRanges: [{ start: 0, end: input.document.text.length }],
    lastViewedAt: input.clock.requestIssuedDateTime - 100,
    lastEditedAt: input.clock.requestIssuedDateTime - 500,
  };
  return {
    current,
    cursorOffset: offsetAtPosition(
      input.document.text,
      input.document.position,
    ),
    recentDocuments: input.contextFiles.map((file, index) => ({
      uri: file.uri,
      path: new URL(file.uri).pathname,
      relativePath: new URL(file.uri).pathname.replace("/workspace/", ""),
      languageId: "typescript",
      version: 1,
      text: file.text,
      workspaceRoot: "/workspace",
      visibleRanges: [{ start: 0, end: file.text.length }],
      lastViewedAt: input.clock.requestIssuedDateTime - (index + 1) * 1_000,
      lastEditedAt: 0,
    })),
    editHistory: input.history.map((entry) => ({
      uri: entry.uri,
      path: new URL(entry.uri).pathname.replace("/workspace/", ""),
      languageId: "typescript",
      before: entry.before,
      after: entry.after,
      timestamp: entry.timestamp,
      reason: "other",
    })),
    diagnostics: input.diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity,
      startLine: diagnostic.line,
      endLine: diagnostic.line,
      source: "ts",
      code: "PARITY",
    })),
    languageContext: {
      symbols: [
        {
          name: "increment",
          detail: "(value: number) => number",
          kind: "Function",
          startLine: 0,
          endLine: 2,
        },
      ],
    },
    gitDiff: "diff --git a/src/counter.ts b/src/counter.ts\n+  return value",
  };
}

export function createCancellationSource(): {
  readonly token: vscode.CancellationToken & JointCancellationSignal;
  cancel(): void;
} {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (
        listener: (event: unknown) => unknown,
        thisArgs?: unknown,
        disposables?: vscode.Disposable[],
      ) => {
        const callback = (): void => {
          listener.call(thisArgs, undefined);
        };
        const disposable: vscode.Disposable = {
          dispose: () => listeners.delete(callback),
        };
        if (cancelled) {
          queueMicrotask(callback);
        } else {
          listeners.add(callback);
        }
        disposables?.push(disposable);
        return disposable;
      },
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

interface ScheduledTrigger {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class ManualTriggerClock implements TriggerClock {
  private value: number;
  private readonly scheduled: ScheduledTrigger[] = [];

  constructor(startAt: number) {
    this.value = startAt;
  }

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): TriggerTimeout {
    const timer: ScheduledTrigger = {
      at: this.value + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.scheduled.push(timer);
    return { dispose: () => (timer.cancelled = true) };
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    const due = this.scheduled
      .filter((timer) => !timer.cancelled && timer.at <= this.value)
      .sort((left, right) => left.at - right.at);
    for (const timer of due) {
      timer.cancelled = true;
      timer.callback();
    }
  }
}

interface JointSleeper {
  readonly at: number;
  resolve(): void;
  resolved: boolean;
}

export class ManualJointClock implements JointClock {
  private value: number;
  private readonly sleepers: JointSleeper[] = [];

  constructor(startAt: number) {
    this.value = startAt;
  }

  now(): number {
    return this.value;
  }

  sleep(delayMs: number): Promise<void> {
    const deferred = createDeferred<void>();
    this.sleepers.push({
      at: this.value + Math.max(0, delayMs),
      resolve: () => deferred.resolve(undefined),
      resolved: false,
    });
    return deferred.promise;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    for (const sleeper of this.sleepers) {
      if (!sleeper.resolved && sleeper.at <= this.value) {
        sleeper.resolved = true;
        sleeper.resolve();
      }
    }
  }
}
