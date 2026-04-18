import { describe, expect, it } from 'bun:test';

import { getFileIcon } from './fileicons';

describe('getFileIcon', () => {
    it('returns language-specific icons for known extensions', () => {
        expect(getFileIcon('index.ts')).toBe('📘');
        expect(getFileIcon('component.tsx')).toBe('⚛️');
        expect(getFileIcon('script.py')).toBe('🐍');
        expect(getFileIcon('query.sql')).toBe('🗄️');
    });

    it('returns project-specific icons for well-known file names', () => {
        expect(getFileIcon('package.json')).toBe('📦');
        expect(getFileIcon('Dockerfile')).toBe('🐳');
        expect(getFileIcon('.gitignore')).toBe('🙈');
        expect(getFileIcon('bun.lock')).toBe('🔒');
    });

    it('prefers exact file name icons over extension icons', () => {
        expect(getFileIcon('tsconfig.json')).toBe('⚙️');
    });

    it('normalizes file names case-insensitively', () => {
        expect(getFileIcon('README.MD')).toBe('📘');
        expect(getFileIcon('DOCKERFILE')).toBe('🐳');
    });

    it('falls back to the default icon for unknown extensions', () => {
        expect(getFileIcon('archive.unknown')).toBe('📄');
        expect(getFileIcon('no-extension')).toBe('📄');
    });
});
