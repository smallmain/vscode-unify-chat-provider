export function shouldEnforceRoutedNesCacheDelay(
  lastSuggestion:
    | {
        readonly documentUri: string;
        readonly documentVersion: number;
        readonly wasShown: boolean;
      }
    | undefined,
  currentDocumentUri: string,
  currentDocumentVersion: number,
): boolean {
  return (
    !lastSuggestion ||
    !lastSuggestion.wasShown ||
    lastSuggestion.documentUri !== currentDocumentUri ||
    lastSuggestion.documentVersion !== currentDocumentVersion
  );
}

export function shouldCaptureNesSuggestion(
  itemUri: string | undefined,
  editUri: string | undefined,
  currentDocumentUri: string,
): boolean {
  return (
    editUri === currentDocumentUri &&
    (itemUri === undefined || itemUri === currentDocumentUri)
  );
}

export function isPresentableNesSuggestion(
  hasEdit: boolean,
  isFallbackCursorJump: boolean,
): boolean {
  return hasEdit || isFallbackCursorJump;
}

export interface CopilotRuntimeAvailabilityInput {
  readonly enableFIM: boolean;
  readonly enableNES: boolean;
  readonly modelUnification: boolean;
  readonly trigger: "automatic" | "invoke";
  readonly completionsEnabled: boolean;
  readonly inlineEditsEnabled: boolean;
}

export interface CopilotRuntimeAvailability {
  readonly fimEnabled: boolean;
  readonly nesEnabled: boolean;
  readonly serveAsCompletionsProvider: boolean;
}

export function resolveCopilotRuntimeAvailability(
  input: CopilotRuntimeAvailabilityInput,
): CopilotRuntimeAvailability {
  const serveAsCompletionsProvider =
    input.modelUnification &&
    input.enableFIM &&
    input.enableNES &&
    input.completionsEnabled &&
    !input.inlineEditsEnabled;
  return {
    fimEnabled:
      !input.modelUnification &&
      input.enableFIM &&
      (input.trigger === "invoke" || input.completionsEnabled),
    nesEnabled:
      input.enableNES &&
      (input.inlineEditsEnabled || serveAsCompletionsProvider),
    serveAsCompletionsProvider,
  };
}

export function resolveJointCursorBranch(
  lineText: string,
  cursorCharacter: number,
): "fim" | "nes" {
  return /^\s*$/.test(lineText.substring(cursorCharacter)) ? "fim" : "nes";
}

export type CopilotPresentedBranch = "fim" | "nes";

export class CopilotPresentedBranchState {
  private active:
    | { readonly item: object; readonly branch: CopilotPresentedBranch }
    | undefined;

  get branch(): CopilotPresentedBranch | undefined {
    return this.active?.branch;
  }

  show(item: object, branch: CopilotPresentedBranch): void {
    this.active = { item, branch };
  }

  end(item: object): void {
    if (this.active?.item === item) {
      this.active = undefined;
    }
  }

  clear(): void {
    this.active = undefined;
  }
}

export function shouldSuppressNesProviderChange(input: {
  readonly jointProviderEnabled: boolean;
  readonly suppressWhileFimInFlight: boolean;
  readonly fimRequestsInFlight: number;
  readonly activePresentedBranch: CopilotPresentedBranch | undefined;
}): boolean {
  return input.jointProviderEnabled
    ? input.suppressWhileFimInFlight && input.fimRequestsInFlight > 0
    : input.activePresentedBranch === "fim";
}

export function quickSuggestionsDisabled(values: {
  readonly other: unknown;
  readonly comments: unknown;
  readonly strings: unknown;
}): boolean {
  return (
    values.other !== "on" && values.comments !== "on" && values.strings !== "on"
  );
}

export function shouldRespectSelectedCompletionInfo(
  explicit: boolean | undefined,
  areQuickSuggestionsDisabled: boolean,
  preRelease: boolean,
): boolean {
  return explicit ?? (areQuickSuggestionsDisabled || preRelease);
}

interface FimListDiscardState {
  readonly totalItemCount: number;
  discardedItemCount: number;
}

/** Tracks whether the global scheduler discarded every item from one core FIM list. */
export class FimListDiscardTracker {
  private readonly states = new Map<string, FimListDiscardState>();

  register(listId: string, itemCount: number): void {
    if (itemCount <= 0) {
      return;
    }
    this.states.set(listId, {
      totalItemCount: itemCount,
      discardedItemCount: 0,
    });
  }

  recordDiscardedItem(listId: string): boolean {
    const state = this.states.get(listId);
    if (!state) {
      return false;
    }
    state.discardedItemCount += 1;
    if (state.discardedItemCount < state.totalItemCount) {
      return false;
    }
    this.states.delete(listId);
    return true;
  }

  endList(listId: string): void {
    this.states.delete(listId);
  }

  clear(): void {
    this.states.clear();
  }
}
