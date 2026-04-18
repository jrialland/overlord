import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Repository } from './repository';

const tempDirs: string[] = [];

function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-repo-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // sqlite can still hold file handles briefly on Windows during teardown.
        }
    }
});

describe('Repository', () => {
    it('can initialize multiple times on the same workspace', () => {
        const workspace = createTempWorkspace();

        const first = new Repository(workspace);
        const session1 = first.createSession('ollama/test', { think: 'true' });

        expect(session1.id).toBeGreaterThan(0);
        first.close();

        // Re-open repository on same sqlite file: must not fail on DDL re-run.
        const second = new Repository(workspace);
        const session2 = second.createSession('ollama/test', {});

        expect(session2.id).toBeGreaterThan(session1.id);
        second.close();
    });

    it('persists and retrieves session data including mode on a fresh workspace', () => {
        const workspace = createTempWorkspace();
        const repository = new Repository(workspace);

        const created = repository.createSession('ollama/test-model', { think: 'false' }, undefined, 'agent');
        const loaded = repository.getSession(created.id);

        expect(loaded).toBeTruthy();
        expect(loaded?.modelName).toBe('ollama/test-model');
        expect(loaded?.mode).toBe('agent');
        expect(loaded?.status).toBe('active');
        repository.close();
    });

    it('can create and read conversation messages on a fresh workspace', () => {
        const workspace = createTempWorkspace();
        const repository = new Repository(workspace);

        const created = repository.createSession('ollama/test-model', {});
        const conversationId = repository.ensureConversation(created.id);

        repository.addMessageToConversation(created.id, 'user', 'hello');
        const messages = repository.getMessagesForConversation(conversationId);

        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe('user');
        expect(messages[0]?.content).toBe('hello');
        repository.close();
    });

    it('can rotate to a new active conversation in the same session', () => {
        const workspace = createTempWorkspace();
        const repository = new Repository(workspace);

        const session = repository.createSession('ollama/test-model', {});
        const initialConversationId = repository.ensureConversation(session.id);

        repository.updateConversationStatus(initialConversationId, 'summarized');
        const nextConversationId = repository.createConversation(session.id, 'active');

        expect(nextConversationId).toBeGreaterThan(initialConversationId);
        expect(repository.ensureConversation(session.id)).toBe(nextConversationId);

        repository.addMessageToConversationById(nextConversationId, 'system', 'summary seed');
        const messages = repository.getMessagesForConversation(nextConversationId);
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe('system');
        repository.close();
    });
});
