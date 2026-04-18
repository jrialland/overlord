import { describe, expect, it } from 'bun:test';

import { createEmbeddingModel, getEmbeddingModelVectorLength } from '../src/agent/providers';

const defaultTimeout = 120000;

describe('Embedding model integration', () => {
    it('returns the real vector length for ollama/nomic-embed-text-v2-moe:latest', async () => {
        const model = await createEmbeddingModel('ollama/nomic-embed-text-v2-moe:latest');
        const vectorLength = await getEmbeddingModelVectorLength(model);

        expect(vectorLength).toBe(768);
    }, defaultTimeout);
});