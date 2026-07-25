import type {
  CompletionAlgorithm,
  CompletionAlgorithmDefinition,
  CompletionAlgorithmOptionsResult,
} from '../types';
import {
  normalizeInceptionAlgorithmOptions,
  normalizeMistralAlgorithmOptions,
  normalizeZedAlgorithmOptions,
} from './options';
import { EditPredictionAlgorithm } from './runtime';
import { ZedEditPredictionLifecycle } from '../zed/lifecycle';

class InvalidEditPredictionAlgorithm implements CompletionAlgorithm {
  async provideInlineCompletions() {
    return undefined;
  }
}

export const zedAlgorithmDefinition: CompletionAlgorithmDefinition = {
  id: 'zed',
  label: 'Zed',
  description: 'Zed Edit Prediction',
  getSettingsDetail(rawOptions) {
    const normalized = normalizeZedAlgorithmOptions(rawOptions);
    return normalized.ok
      ? `${normalized.value.model.vendor}/${normalized.value.model.id} | maxTokens: ${normalized.value.maxTokens}`
      : normalized.error;
  },
  getModelReferences(options) {
    const normalized = normalizeZedAlgorithmOptions(options);
    return normalized.ok ? [normalized.value.model] : [];
  },
  normalizeOptions(raw): CompletionAlgorithmOptionsResult {
    return normalizeZedAlgorithmOptions(raw);
  },
  create(context) {
    const normalized = normalizeZedAlgorithmOptions(context.options);
    return normalized.ok
      ? new EditPredictionAlgorithm(
          'zed',
          context,
          normalized.value,
          new ZedEditPredictionLifecycle(),
        )
      : new InvalidEditPredictionAlgorithm();
  },
};

export const inceptionAlgorithmDefinition: CompletionAlgorithmDefinition = {
  id: 'inception',
  label: 'Inception',
  description: 'Inception Next Edit',
  getSettingsDetail(rawOptions) {
    const normalized = normalizeInceptionAlgorithmOptions(rawOptions);
    return normalized.ok
      ? `${normalized.value.model.vendor}/${normalized.value.model.id}`
      : normalized.error;
  },
  getModelReferences(options) {
    const normalized = normalizeInceptionAlgorithmOptions(options);
    return normalized.ok ? [normalized.value.model] : [];
  },
  normalizeOptions(raw): CompletionAlgorithmOptionsResult {
    return normalizeInceptionAlgorithmOptions(raw);
  },
  create(context) {
    const normalized = normalizeInceptionAlgorithmOptions(context.options);
    return normalized.ok
      ? new EditPredictionAlgorithm('inception', context, normalized.value)
      : new InvalidEditPredictionAlgorithm();
  },
};

export const mistralAlgorithmDefinition: CompletionAlgorithmDefinition = {
  id: 'mistral',
  label: 'Mistral',
  description: 'Mistral Codestral FIM',
  getSettingsDetail(rawOptions) {
    const normalized = normalizeMistralAlgorithmOptions(rawOptions);
    return normalized.ok
      ? `${normalized.value.model.vendor}/${normalized.value.model.id} | maxTokens: ${normalized.value.maxTokens}`
      : normalized.error;
  },
  getModelReferences(options) {
    const normalized = normalizeMistralAlgorithmOptions(options);
    return normalized.ok ? [normalized.value.model] : [];
  },
  normalizeOptions(raw): CompletionAlgorithmOptionsResult {
    return normalizeMistralAlgorithmOptions(raw);
  },
  create(context) {
    const normalized = normalizeMistralAlgorithmOptions(context.options);
    return normalized.ok
      ? new EditPredictionAlgorithm('mistral', context, normalized.value)
      : new InvalidEditPredictionAlgorithm();
  },
};
