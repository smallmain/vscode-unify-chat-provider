import { describe, expect, it } from 'vitest';
import {
  createVsCodeModelId,
  parseVsCodeModelId,
} from '../../src/model-id-utils';

describe('VS Code model IDs', () => {
  it('round-trips provider names containing slashes and percent signs', () => {
    const encoded = createVsCodeModelId('team/100%', 'model-id');

    expect(encoded).toBe('team%2F100%25/model-id');
    expect(parseVsCodeModelId(encoded)).toEqual({
      providerName: 'team/100%',
      modelName: 'model-id',
    });
  });
});
