import type * as vscode from 'vscode';
import {
  determineGhostTextMultilineStrategy,
  type GhostTextBehavior,
  type GhostTextPrompt,
  type GhostTextRequest,
  type GhostTextTokenizer,
} from '../../src/chat-lib/core/ghost-text';
import type { CompletionModel } from '../../src/completion/types';
import type {
  AlgorithmRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from '../../src/completion/model/requests';
import type {
  AlgorithmResponse,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from '../../src/completion/model/responses';

export * from '../../src/chat-lib/core/ghost-text';

export type RecordedFimRequest = CopilotReplicaAlgorithmFimRequest;
export type RecordedFimResult = Omit<
  CopilotReplicaAlgorithmFimResponse,
  'kind'
>;

export class RecordingCompletionModel implements CompletionModel {
  readonly requests: RecordedFimRequest[] = [];
  readonly tokens: vscode.CancellationToken[] = [];
  private calls = 0;

  constructor(
    private readonly response: (
      call: number,
      request: RecordedFimRequest,
      token: vscode.CancellationToken,
    ) => Promise<RecordedFimResult> | RecordedFimResult,
  ) {}

  getCapabilities() {
    return Promise.resolve({ supportsNextCursorLinePrediction: false });
  }

  complete(
    request: SimpleAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<SimpleAlgorithmResponse>;
  complete(
    request: CopilotReplicaAlgorithmFimRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmFimResponse>;
  complete(
    request: CopilotReplicaAlgorithmNesRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmNesResponse>;
  complete(
    request: CopilotReplicaAlgorithmCursorPredictionRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmCursorPredictionResponse>;
  complete(
    request: ZedAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<ZedAlgorithmResponse>;
  complete(
    request: InceptionAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<InceptionAlgorithmResponse>;
  complete(
    request: MistralAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<MistralAlgorithmResponse>;
  async complete(
    request: AlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    if (request.kind !== 'copilot-replica/fim') {
      throw new Error(`Unexpected completion request kind "${request.kind}".`);
    }
    this.requests.push(request);
    this.tokens.push(token);
    return {
      kind: 'copilot-replica/fim',
      ...(await this.response(this.calls++, request, token)),
    };
  }
}

export class CharacterGhostTextTokenizer implements GhostTextTokenizer {
  encode(text: string): readonly number[] {
    return Array.from(text, (character) => character.codePointAt(0) ?? 0);
  }

  decode(tokens: readonly number[]): string {
    return String.fromCodePoint(...tokens);
  }

  count(text: string): number {
    return Array.from(text).length;
  }

  takeFirst(
    text: string,
    maxTokens: number,
  ): { text: string; tokens: readonly number[] } {
    const tokens = this.encode(text).slice(0, Math.max(0, maxTokens));
    return { text: this.decode(tokens), tokens };
  }

  takeLast(
    text: string,
    maxTokens: number,
  ): { text: string; tokens: readonly number[] } {
    const tokens = this.encode(text);
    const selected = tokens.slice(Math.max(0, tokens.length - maxTokens));
    return { text: this.decode(selected), tokens: selected };
  }

  tokenizeStrings(text: string): readonly string[] {
    return Array.from(text);
  }
}

export async function shouldRequestMultiline(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  behavior: GhostTextBehavior,
  afterAcceptedCompletion: boolean,
): Promise<boolean> {
  return (
    await determineGhostTextMultilineStrategy(
      request,
      prompt,
      behavior,
      afterAcceptedCompletion,
    )
  ).requestMultiline;
}
