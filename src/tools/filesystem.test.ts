import { afterEach, describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import type { ImagePart } from 'ai';

import { FileSystemTools } from './filesystem';

let currentWorkspace: string | null = null;

async function makeFsTools(): Promise<FileSystemTools> {
    currentWorkspace = await mkdtemp(path.join(os.tmpdir(), 'filesystem-tools-'));
    return new FileSystemTools(currentWorkspace);
}

afterEach(async () => {
    if (currentWorkspace) {
        await rm(currentWorkspace, { recursive: true, force: true });
        currentWorkspace = null;
    }
});

describe('FileSystemTools', () => {
    it('lists directory content recursively', async () => {
        const fsTools = await makeFsTools();

        await mkdir(path.join(currentWorkspace!, 'src', 'nested'), { recursive: true });
        await writeFile(path.join(currentWorkspace!, 'src', 'nested', 'hello.txt'), 'hello', 'utf-8');

        const result = await fsTools.listDir('src', true);

        expect(result).toContain('nested');
        expect(result).toContain('hello.txt');
    });

    it('writes and reads a text file', async () => {
        const fsTools = await makeFsTools();

        const writeResult = await fsTools.writeTextToFile('notes/todo.txt', 'first\nsecond\nthird\n');
        expect(writeResult).toContain('Wrote');

        const content = await fsTools.readTextFile('notes/todo.txt', 2, 2, true);
        expect(content).toContain('2: second');
        expect(content).toContain('3: third');
    });

    it('uses 1-based line offsets for readTextFile', async () => {
        const fsTools = await makeFsTools();

        await fsTools.writeTextToFile('notes/todo.txt', 'first\nsecond\nthird\n');

        await expect(fsTools.readTextFile('notes/todo.txt', 0, 1, true)).rejects.toThrow('lineOffset must be >= 1');

        const firstLine = await fsTools.readTextFile('notes/todo.txt', 1, 1, true);
        expect(firstLine).toContain('1: first');
    });

    it('appends text when append=true', async () => {
        const fsTools = await makeFsTools();

        await fsTools.writeTextToFile('log.txt', 'line1\n');
        const appendResult = await fsTools.writeTextToFile('log.txt', 'line2\n', true);

        const finalContent = await readFile(path.join(currentWorkspace!, 'log.txt'), 'utf-8');
        expect(appendResult).toContain('Appended');
        expect(finalContent).toBe('line1\nline2\n');
    });

    it('moves files to a new path', async () => {
        const fsTools = await makeFsTools();

        await fsTools.writeTextToFile('from/source.txt', 'payload');
        await fsTools.moveFileOrDir('from/source.txt', 'to/target.txt');

        const movedContent = await readFile(path.join(currentWorkspace!, 'to', 'target.txt'), 'utf-8');
        expect(movedContent).toBe('payload');
    });

    it('finds files by glob', async () => {
        const fsTools = await makeFsTools();

        await mkdir(path.join(currentWorkspace!, 'a', 'b'), { recursive: true });
        await writeFile(path.join(currentWorkspace!, 'a', 'b', 'one.ts'), 'export const one = 1;', 'utf-8');
        await writeFile(path.join(currentWorkspace!, 'a', 'b', 'two.ts'), 'export const two = 2;', 'utf-8');

        const result = await fsTools.findFiles('a', '**/*.ts');
        expect(result).toContain('one.ts');
        expect(result).toContain('two.ts');
    });

    it('deletes files and directories', async () => {
        const fsTools = await makeFsTools();

        await fsTools.writeTextToFile('trash/file.txt', 'x');
        await fsTools.delete('trash/file.txt');

        await expect(stat(path.join(currentWorkspace!, 'trash', 'file.txt'))).rejects.toThrow();

        await fsTools.delete('trash');
        await expect(stat(path.join(currentWorkspace!, 'trash'))).rejects.toThrow();
    });

    it('returns base64 image payload for supported image types', async () => {
        const fsTools = await makeFsTools();

        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        await fsTools.writeTextToFile('img/tiny.svg', svg);

        const result = await fsTools.viewImageFile('img/tiny.svg');
        // Compile-time guard: the tool return type must remain AI SDK-compatible.
        const typedResult: ImagePart[] = result;

        expect(typedResult).toHaveLength(1);
        expect(typedResult[0]!.type).toBe('image');
        expect(typedResult[0]!.mediaType).toBe('image/svg+xml');
        expect(typedResult[0]!.image).toBeTypeOf('string');
        expect((typedResult[0]!.image as string).length).toBeGreaterThan(0);
    });

    it('blocks path traversal outside workspace', async () => {
        const fsTools = await makeFsTools();

        await expect(fsTools.listDir('../', false)).rejects.toThrow('Access to path is not allowed');
    });
});
