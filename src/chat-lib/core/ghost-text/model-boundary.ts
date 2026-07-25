import type * as vscode from 'vscode';
import type { CompletionModel } from '../../../completion/types';
import type { CopilotReplicaAlgorithmFimRequest } from '../../../completion/model/requests';
import type { CopilotReplicaAlgorithmFimResponse } from '../../../completion/model/responses';
import type {
  GhostTextModelBoundary,
  GhostTextModelChoice,
  GhostTextModelRequest,
} from './types';

interface ParsedCandidate {
  text: string;
  finishReason?: string;
  usage?: unknown;
}

/**
 * Adapts the extension's CompletionModel contract to the API-choice shape
 * consumed by GhostText. Multi-candidate transports return `choices` from one
 * request. Single-result transports degrade cycling to one candidate rather
 * than multiplying requests behind the caller's back.
 */
export class FimGhostTextModelBoundary implements GhostTextModelBoundary {
  constructor(
    private readonly model: CompletionModel,
    private readonly idFactory: () => string,
  ) {}

  async complete(
    request: GhostTextModelRequest,
    token: vscode.CancellationToken,
  ): Promise<readonly GhostTextModelChoice[]> {
    throwIfCancelled(token);
    const requestedCandidateCount = request.candidateCount;
    const fimRequest: CopilotReplicaAlgorithmFimRequest = {
      kind: 'copilot-replica/fim',
      ...(request.filePath ? { targetPath: request.filePath } : {}),
      prefix: request.prompt.prefix,
      suffix: request.prompt.suffix,
      contexts: request.prompt.contextFiles.map((file) => ({
        ...(file.path ? { path: file.path } : {}),
        content: file.content,
      })),
      options: {
        candidateCount: requestedCandidateCount,
        ...(request.stop === undefined ? {} : { stop: [...request.stop] }),
        ...(request.maxTokens === undefined
          ? {}
          : { maxTokens: request.maxTokens }),
      },
      metadata: {
        languageId: request.languageId,
        nextIndent: request.nextIndent,
        trimByIndentation: request.trimByIndentation,
        promptTokens: request.promptTokens,
        suffixTokens: request.suffixTokens,
        codeAnnotations: request.codeAnnotations,
      },
    };

    const result = await this.model.complete(fimRequest, token);
    throwIfCancelled(token);
    const candidates: readonly ParsedCandidate[] = result.choices?.length
      ? result.choices.map((candidate) => ({
          ...candidate,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        }))
      : [asCandidate(result)];

    return candidates
      .slice(0, requestedCandidateCount)
      .map((candidate, choiceIndex) => ({
        choiceIndex,
        completionText: candidate.text,
        requestId: request.requestId,
        clientCompletionId: this.idFactory(),
        ...(candidate.finishReason === undefined
          ? {}
          : { finishReason: candidate.finishReason }),
        ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
      }));
  }
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    const error = new Error('GhostText FIM request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function asCandidate(
  result: CopilotReplicaAlgorithmFimResponse,
): ParsedCandidate {
  return {
    text: result.text,
    ...(result.finishReason === undefined
      ? {}
      : { finishReason: result.finishReason }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}
