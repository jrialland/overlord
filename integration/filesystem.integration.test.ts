import { describe, expect, it } from 'bun:test';

import { FileSystemTools } from '../src/tools/filesystem';

describe('FileSystemTools', () => {

    const workspace = process.cwd();
    const fsTools = new FileSystemTools(workspace);

    it('lists the current directory', async () => {
        const result = await fsTools.listDir(undefined, true, undefined, true);
        console.log(result);
        expect(result).toContain('src');
        expect(result).toContain('integration');
    });
});