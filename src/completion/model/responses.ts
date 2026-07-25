export interface CompletionChoice {
  readonly text: string;
  readonly finishReason?: string;
}

export interface BufferedCompletionResponse {
  readonly mode: 'buffered';
  readonly choices: readonly CompletionChoice[];
  readonly usage?: unknown;
  readonly edit?: CompletionEditMetadata;
}

export interface CompletionEditMetadata {
  readonly requestId?: string;
  readonly modelVersion?: string;
  readonly targetUri?: string;
  readonly requestSnapshot?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly jumpOffset?: number;
  readonly edits?: readonly CompletionTextEdit[];
}

export interface CompletionTextEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface StreamingCompletionResponse {
  readonly mode: 'streaming';
  readonly text: AsyncIterable<string>;
}

export interface SimpleAlgorithmResponse {
  readonly kind: 'simple';
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: unknown;
  readonly choices?: readonly CompletionChoice[];
}

export interface CopilotReplicaAlgorithmFimResponse {
  readonly kind: 'copilot-replica/fim';
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: unknown;
  readonly choices?: readonly CompletionChoice[];
}

export interface CopilotReplicaAlgorithmNesResponse {
  readonly kind: 'copilot-replica/nes';
  readonly text: AsyncIterable<string>;
}

export interface CopilotReplicaAlgorithmCursorPredictionResponse {
  readonly kind: 'copilot-replica/cursor-prediction';
  readonly text: AsyncIterable<string>;
}

export interface EditAlgorithmResponseBase {
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: unknown;
  readonly edit?: CompletionEditMetadata;
}

export interface ZedAlgorithmResponse extends EditAlgorithmResponseBase {
  readonly kind: 'zed';
}

export interface InceptionAlgorithmResponse extends EditAlgorithmResponseBase {
  readonly kind: 'inception';
}

export interface MistralAlgorithmResponse extends EditAlgorithmResponseBase {
  readonly kind: 'mistral';
}

export interface AlgorithmResponseMap {
  readonly simple: SimpleAlgorithmResponse;
  readonly 'copilot-replica/fim': CopilotReplicaAlgorithmFimResponse;
  readonly 'copilot-replica/nes': CopilotReplicaAlgorithmNesResponse;
  readonly 'copilot-replica/cursor-prediction':
    CopilotReplicaAlgorithmCursorPredictionResponse;
  readonly zed: ZedAlgorithmResponse;
  readonly inception: InceptionAlgorithmResponse;
  readonly mistral: MistralAlgorithmResponse;
}

export interface CompletionResponseMap {
  readonly fim: BufferedCompletionResponse;
  readonly codegemma: BufferedCompletionResponse;
  readonly 'copilot-replica-nes': StreamingCompletionResponse;
  readonly zeta1: BufferedCompletionResponse;
  readonly zeta2: BufferedCompletionResponse;
  readonly 'zeta2.1': BufferedCompletionResponse;
  readonly 'zeta3-internal': BufferedCompletionResponse;
  readonly 'mercury-edit-2': BufferedCompletionResponse;
  readonly codestral: BufferedCompletionResponse;
}

export type AlgorithmResponse = AlgorithmResponseMap[keyof AlgorithmResponseMap];
export type CompletionResponse =
  CompletionResponseMap[keyof CompletionResponseMap];
