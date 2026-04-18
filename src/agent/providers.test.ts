import { describe, expect, it } from 'bun:test';

import { resolveContextWindowSize } from './providers';

describe('resolveContextWindowSize', () => {
    it('prefers explicit configuration over any inferred value', async () => {
        await expect(
            resolveContextWindowSize('openai/gpt-4o', { contextWindowSize: 77777 }),
        ).resolves.toBe(77777);
    });

    it('reads context window size from the vendored LiteLLM model map', async () => {
        await expect(resolveContextWindowSize('openai/gpt-4o')).resolves.toBe(128000);
    });

    it('reads an exact provider-prefixed key from the vendored LiteLLM model map', async () => {
        await expect(resolveContextWindowSize('moonshot/kimi-k2.5')).resolves.toBe(262144);
    });

    it('falls back to the last-resort default when the model is unknown', async () => {
        await expect(resolveContextWindowSize('unknown-provider/unknown-model')).resolves.toBe(32768);
    });
});