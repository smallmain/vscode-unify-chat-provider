import * as vscode from 'vscode';
import { t } from '../../i18n';
import type {
  CodeGemmaCompletionRequest,
  CopilotReplicaNesCompletionRequest,
  FimCompletionRequest,
} from '../model/requests';
import type { BufferedCompletionResponse } from '../model/responses';
import {
  buildCompatibleSystemPrompt,
  buildCompatibleUserPrompt,
} from '../template/compatible-prompt';
import {
  buildEffectiveStops,
  postprocessCompatibleCompletionText,
} from '../template/postprocess';
import { toCompletionRequestError } from '../model/errors';
import { createCompletionRequestLogger } from './logging';
import type {
  CompletionApiOperation,
  CompletionApiProvider,
} from './provider';
import { defineCompletionApiProvider } from './provider';
import { createOutgoingLanguageModelMessages } from '../../proposed-api/system-message';

export type CompatibleChatModel = Pick<vscode.LanguageModelChat, 'sendRequest'>;

export interface CompatibleApiProviderContext {
  readonly model: string;
  readonly canUseSystemMessage?: boolean;
}

type RequestLogger = NonNullable<
  ReturnType<typeof createCompletionRequestLogger>
>;

class CompatibleOperationLogger {
  private finished = false;
  private cancellationSubscription: vscode.Disposable | undefined;

  constructor(private readonly logger: RequestLogger) {}

  languageModelRequest(
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions,
  ): void {
    this.logger.languageModelRequest(messages, options);
  }

  responseChunk(chunk: string): void {
    if (!this.finished) this.logger.languageModelResponseChunk(chunk);
  }

  trackStreamingCancellation(token: vscode.CancellationToken): void {
    if (this.finished || this.cancellationSubscription) return;
    this.cancellationSubscription = token.onCancellationRequested(() => {
      this.cancelled();
    });
    if (token.isCancellationRequested) this.cancelled();
  }

  complete(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
      this.cancelled();
      return;
    }
    this.finish(() => this.logger.complete());
  }

  failed(error: unknown, token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
      this.cancelled();
      return;
    }
    this.finish(() => this.logger.error(error));
  }

  cancelled(): void {
    this.finish(() => this.logger.cancelled());
  }

  private finish(writeTerminal: () => void): void {
    if (this.finished) return;
    this.finished = true;
    this.cancellationSubscription?.dispose();
    this.cancellationSubscription = undefined;
    writeTerminal();
  }
}

function createOperationLogger(
  context: CompatibleApiProviderContext,
  requestKind:
    | FimCompletionRequest['kind']
    | CodeGemmaCompletionRequest['kind']
    | CopilotReplicaNesCompletionRequest['kind'],
): CompatibleOperationLogger | undefined {
  const logger = createCompletionRequestLogger({
    transport: 'compatible',
    requestKind,
    model: context.model,
  });
  return logger ? new CompatibleOperationLogger(logger) : undefined;
}

async function collectText(
  chunks: AsyncIterable<string>,
  token: vscode.CancellationToken,
  logger: CompatibleOperationLogger | undefined,
): Promise<string> {
  let text = '';
  for await (const chunk of chunks) {
    logger?.responseChunk(chunk);
    if (token.isCancellationRequested) {
      return '';
    }
    text += chunk;
  }
  return text;
}

async function* wrapStreamingText(
  chunks: AsyncIterable<string>,
  token: vscode.CancellationToken,
  logger: CompatibleOperationLogger | undefined,
): AsyncIterable<string> {
  let ended = false;
  try {
    for await (const chunk of chunks) {
      logger?.responseChunk(chunk);
      if (token.isCancellationRequested) return;
      yield chunk;
    }
    ended = true;
    logger?.complete(token);
  } catch (error) {
    ended = true;
    logger?.failed(error, token);
    throw toCompletionRequestError(error, token);
  } finally {
    if (!ended) logger?.cancelled();
  }
}

function createBufferedOperation<
  Request extends FimCompletionRequest | CodeGemmaCompletionRequest,
>(
  model: CompatibleChatModel,
  context: CompatibleApiProviderContext,
  kind: Request['kind'],
): CompletionApiOperation<Request['kind']> {
  return {
    async execute(request, token): Promise<BufferedCompletionResponse> {
      const logger = createOperationLogger(context, kind);
      try {
        const userPrompt = buildCompatibleUserPrompt(request);
        const messages = createOutgoingLanguageModelMessages(
          [
            { role: 'system', content: buildCompatibleSystemPrompt(kind) },
            { role: 'user', content: userPrompt },
          ],
          context.canUseSystemMessage ?? true,
        );
        const options = {
          justification: t('Provide inline code completion'),
        };
        logger?.languageModelRequest(messages, options);
        const response = await model.sendRequest(messages, options, token);
        const text = await collectText(response.text, token, logger);
        const result: BufferedCompletionResponse = {
          mode: 'buffered',
          choices: [
            {
              text: postprocessCompatibleCompletionText(
                text,
                userPrompt,
                buildEffectiveStops(request.options.stop),
              ),
            },
          ],
        };
        logger?.complete(token);
        return result;
      } catch (error) {
        logger?.failed(error, token);
        throw toCompletionRequestError(error, token);
      }
    },
  };
}

function createNesOperation(
  model: CompatibleChatModel,
  context: CompatibleApiProviderContext,
): CompletionApiOperation<'copilot-replica-nes'> {
  return {
    async execute(
      request: CopilotReplicaNesCompletionRequest,
      token,
    ) {
      const logger = createOperationLogger(context, request.kind);
      try {
        const modelOptions = buildNesModelOptions(request);
        const messages = createOutgoingLanguageModelMessages(
          request.messages,
          context.canUseSystemMessage ?? true,
        );
        const options = {
          justification: t('Predict the next code edit'),
          ...(modelOptions === undefined ? {} : { modelOptions }),
        };
        logger?.languageModelRequest(messages, options);
        const response = await model.sendRequest(messages, options, token);
        logger?.trackStreamingCancellation(token);
        return {
          mode: 'streaming',
          text: wrapStreamingText(response.text, token, logger),
        };
      } catch (error) {
        logger?.failed(error, token);
        throw toCompletionRequestError(error, token);
      }
    },
  };
}

function buildNesModelOptions(
  request: CopilotReplicaNesCompletionRequest,
): Record<string, unknown> | undefined {
  const result = {
    ...(request.maxTokens === undefined
      ? {}
      : { max_tokens: request.maxTokens }),
    ...(request.prediction === undefined
      ? {}
      : { prediction: request.prediction }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

export function createCompatibleApiProvider(
  model: CompatibleChatModel,
  context: CompatibleApiProviderContext,
): CompletionApiProvider {
  return defineCompletionApiProvider({
    transport: 'compatible',
    capabilities: {
      fim: {
        responseMode: 'buffered',
        multiCandidateSupport: 'single-result-only',
      },
      codegemma: {
        responseMode: 'buffered',
        multiCandidateSupport: 'single-result-only',
      },
      'copilot-replica-nes': {
        responseMode: 'streaming',
        multiCandidateSupport: 'single-result-only',
      },
    },
    operations: {
      fim: createBufferedOperation<FimCompletionRequest>(
        model,
        context,
        'fim',
      ),
      codegemma: createBufferedOperation<CodeGemmaCompletionRequest>(
        model,
        context,
        'codegemma',
      ),
      'copilot-replica-nes': createNesOperation(model, context),
    },
  });
}
