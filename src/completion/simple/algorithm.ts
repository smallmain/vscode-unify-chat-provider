import * as vscode from 'vscode';
import { t } from '../../i18n';
import type {
  CompletionAlgorithm,
  CompletionAlgorithmContext,
  CompletionAlgorithmDefinition,
  CompletionAlgorithmOptionsResult,
  CompletionModel,
} from '../types';
import type { SimpleAlgorithmRequest } from '../model/requests';
import type { SimpleAlgorithmResponse } from '../model/responses';
import { CompletionConfigurationError } from '../model/errors';
import {
  normalizeSimpleAlgorithmOptions,
  type SimpleAlgorithmOptions,
} from './options';

export function buildSimpleAlgorithmRequest(
  text: string,
  offset: number,
): SimpleAlgorithmRequest {
  const normalizedOffset = Math.max(0, Math.min(text.length, offset));
  return {
    kind: 'simple',
    prefix: text.slice(0, normalizedOffset),
    suffix: text.slice(normalizedOffset),
  };
}

class SimpleAlgorithm implements CompletionAlgorithm {
  constructor(
    private readonly context: CompletionAlgorithmContext,
    private readonly options: SimpleAlgorithmOptions,
  ) {}

  async provideInlineCompletions(
    input: Parameters<CompletionAlgorithm['provideInlineCompletions']>[0],
    token: vscode.CancellationToken,
  ) {
    const request = buildSimpleAlgorithmRequest(
      input.document.getText(),
      input.document.offsetAt(input.position),
    );
    let model: CompletionModel;
    try {
      const eligibility =
        await this.context.modelResolver.evaluateModelForRequest?.(
          this.options.model,
          request.kind,
        );
      if (eligibility && !eligibility.eligible) {
        this.context.reportConfigurationError(
          `${eligibility.code ?? 'model-ineligible'}:${this.options.model.vendor}:${this.options.model.id}`,
          eligibility.message ?? t('The selected completion model is unavailable.'),
        );
        return undefined;
      }
      model = await this.context.modelResolver.resolveCompletionModel(
        this.options.model,
        token,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.reportConfigurationError(
        `model:${this.options.model.vendor}:${this.options.model.id}`,
        message,
      );
      return undefined;
    }
    let response: SimpleAlgorithmResponse;
    try {
      response = await model.complete(request, token);
    } catch (error) {
      if (!(error instanceof CompletionConfigurationError)) {
        throw error;
      }
      this.context.reportConfigurationError(
        `${error.code}:${this.options.model.vendor}:${this.options.model.id}`,
        error.message,
      );
      return undefined;
    }
    if (token.isCancellationRequested || !response.text) {
      return undefined;
    }
    return {
      providerId: this.context.entry.id,
      items: [
        new vscode.InlineCompletionItem(
          response.text,
          new vscode.Range(input.position, input.position),
        ),
      ],
      metadata: {
        ...(response.finishReason === undefined
          ? {}
          : { finishReason: response.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      },
    };
  }
}

class InvalidSimpleAlgorithm implements CompletionAlgorithm {
  async provideInlineCompletions() {
    return undefined;
  }
}

export const simpleAlgorithmDefinition: CompletionAlgorithmDefinition = {
  id: 'simple',
  label: t('Simple'),
  description: t('Prefix and suffix code completion'),
  getSettingsDetail(rawOptions) {
    const normalized = normalizeSimpleAlgorithmOptions(rawOptions);
    return normalized.ok
      ? t(
          'Model: {0}',
          `${normalized.value.model.vendor}/${normalized.value.model.id}`,
        )
      : t('Invalid configuration: {0}', normalized.error);
  },
  getModelReferences(options) {
    const normalized = normalizeSimpleAlgorithmOptions(options);
    return normalized.ok ? [normalized.value.model] : [];
  },
  normalizeOptions(raw): CompletionAlgorithmOptionsResult {
    return normalizeSimpleAlgorithmOptions(raw);
  },
  create(context): CompletionAlgorithm {
    const normalized = normalizeSimpleAlgorithmOptions(context.options);
    return normalized.ok
      ? new SimpleAlgorithm(context, normalized.value)
      : new InvalidSimpleAlgorithm();
  },
};
