import { describe, it, expect, vi } from 'vitest';
import { resolveGroqModel, DEFAULT_GROQ_MODEL } from '../src/config';

describe('resolveGroqModel', () => {
  it('uses the default when unset', () => expect(resolveGroqModel(undefined)).toBe(DEFAULT_GROQ_MODEL));
  it('replaces a model Groq has retired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveGroqModel('llama-3.1-8b-instant')).toBe(DEFAULT_GROQ_MODEL);
    expect(warn).toHaveBeenCalled();
  });
  it('keeps any other explicit model', () => expect(resolveGroqModel('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b'));
});
