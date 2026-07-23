export type JointSource = "fim" | "nes";

export type JointDisposeReason =
  "empty" | "token-cancellation" | "lost-race" | "not-taken";

export interface JointCompletionList<TItem> {
  readonly items: readonly TItem[];
}

export interface JointOffsetEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export interface JointItemSemantics<TItem> {
  getEdit(item: TItem): JointOffsetEdit | undefined;
  isVisible(item: TItem, documentText: string): boolean;
  isInlineEdit?(item: TItem): boolean;
  showInlineEditMenu?(item: TItem): boolean;
}

export interface JointCancellationSubscription {
  dispose(): void;
}

export interface JointCancellationSignal {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): JointCancellationSubscription;
}

export interface JointClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface JointStartedRequest<TItem> {
  readonly result: Promise<JointCompletionList<TItem> | undefined>;
  cancel(reason: JointDisposeReason): void;
  disposeWhenSettled?(reason: JointDisposeReason): void;
}

export interface JointFimBranch<TItem> {
  start(): JointStartedRequest<TItem>;
}

export interface JointNesBranch<TItem> {
  start(enforceCacheDelay: boolean): JointStartedRequest<TItem>;
}

export type JointArbitrationResult<TFimItem, TNesItem> =
  | {
      readonly kind: "result";
      readonly source: "fim";
      readonly list: JointCompletionList<TFimItem>;
    }
  | {
      readonly kind: "result";
      readonly source: "nes";
      readonly list: JointCompletionList<TNesItem>;
    }
  | {
      readonly kind: "empty";
    }
  | {
      readonly kind: "cancelled";
    }
  | {
      readonly kind: "failed";
      readonly source: JointSource;
      readonly error: unknown;
    };

export interface LastShownNesSuggestion {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly documentWithEditApplied: string;
  readonly wasShown: boolean;
}

export interface JointArbitrationInput<TFimItem, TNesItem> {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly documentText: string;
  readonly fim?: JointFimBranch<TFimItem>;
  readonly nes?: JointNesBranch<TNesItem>;
  readonly fimSemantics: JointItemSemantics<TFimItem>;
  readonly nesSemantics: JointItemSemantics<TNesItem>;
  readonly lastNesSuggestion?: LastShownNesSuggestion;
  readonly selectionTriggered?: boolean;
  readonly enforceCacheDelay?: boolean;
  readonly cancellation?: JointCancellationSignal;
  readonly clock?: JointClock;
  readonly cacheWaitMs?: number;
}

export type SeparateProviderRequestScope = "all" | JointSource;

export type SeparateProviderItem<TFimItem, TNesItem> =
  | { readonly source: "fim"; readonly item: TFimItem }
  | { readonly source: "nes"; readonly item: TNesItem };

export type SeparateProviderArbitrationResult<TFimItem, TNesItem> =
  | {
      readonly kind: "result";
      readonly source: JointSource;
      readonly list: JointCompletionList<
        SeparateProviderItem<TFimItem, TNesItem>
      >;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "cancelled" };

export interface SeparateProviderArbitrationInput<TFimItem, TNesItem> {
  readonly documentText: string;
  readonly fim?: JointFimBranch<TFimItem>;
  readonly nes?: JointNesBranch<TNesItem>;
  readonly fimSemantics: JointItemSemantics<TFimItem>;
  readonly nesSemantics: JointItemSemantics<TNesItem>;
  readonly trigger: "automatic" | "explicit";
  readonly requestScope?: SeparateProviderRequestScope;
  readonly includeInlineCompletions?: boolean;
  readonly includeInlineEdits?: boolean;
  readonly enforceCacheDelay?: boolean;
  readonly cancellation?: JointCancellationSignal;
  readonly clock?: JointClock;
}
