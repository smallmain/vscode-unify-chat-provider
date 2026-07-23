import { describe, expect, it } from 'vitest';
import {
  appendMistralContentChunks,
  parseMistralContentChunks,
} from '../../src/client/openai/mistral-content';

describe('Mistral structured content', () => {
  it('preserves thinking and text arrival order', () => {
    const content = [
      {
        type: 'thinking',
        thinking: [
          { type: 'text', text: 'first thought' },
          { type: 'reference', reference_ids: ['ref-1'] },
          { type: 'text', text: 'second thought' },
        ],
      },
      { type: 'text', text: 'first answer' },
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'third thought' }],
      },
      { type: 'text', text: 'second answer' },
    ];

    expect(parseMistralContentChunks(content)).toEqual([
      { type: 'thinking', text: 'first thought' },
      { type: 'thinking', text: 'second thought' },
      { type: 'text', text: 'first answer' },
      { type: 'thinking', text: 'third thought' },
      { type: 'text', text: 'second answer' },
    ]);
    expect(content[0]).toEqual({
      type: 'thinking',
      thinking: [
        { type: 'text', text: 'first thought' },
        { type: 'reference', reference_ids: ['ref-1'] },
        { type: 'text', text: 'second thought' },
      ],
    });
  });

  it('can parse consecutive streaming arrays without combining their chunks', () => {
    const deltas = [
      [
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'think-1' }],
        },
      ],
      [{ type: 'text', text: 'answer-1' }],
      [
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'think-2' }],
        },
        { type: 'text', text: 'answer-2' },
      ],
    ];

    expect(deltas.flatMap((delta) => parseMistralContentChunks(delta) ?? []))
      .toEqual([
        { type: 'thinking', text: 'think-1' },
        { type: 'text', text: 'answer-1' },
        { type: 'thinking', text: 'think-2' },
        { type: 'text', text: 'answer-2' },
      ]);
  });

  it('does not reinterpret ordinary string content', () => {
    expect(parseMistralContentChunks('plain response')).toBeUndefined();
    expect(parseMistralContentChunks(null)).toBeUndefined();
  });

  it('retains the original arrays when accumulating a streaming response', () => {
    const thinking = {
      type: 'thinking',
      thinking: [{ type: 'text', text: 'reasoning' }],
    };
    const text = { type: 'text', text: 'answer' };

    const first = appendMistralContentChunks(undefined, [thinking]);
    const complete = appendMistralContentChunks(first, [text]);

    expect(complete).toEqual([thinking, text]);
    expect(Array.isArray(complete)).toBe(true);
    expect(appendMistralContentChunks(complete, 'plain text')).toBeUndefined();
  });
});
