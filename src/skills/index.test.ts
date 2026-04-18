import { describe, expect, it } from 'bun:test';
import { SkillsLoader } from '.';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('SkillsLoader', () => {
    it('should load skills from the workspace', async () => {
        const loader = new SkillsLoader('./');
        await loader.loadAllSkills();
        const summary = await loader.getSummaryOfAllSkills();
        console.log(summary);
        expect(summary).toBeTruthy();
    });

    it('can resolve and load a skill by name via Skill tool without explicit preload', async () => {
        const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-loader-'));
        const skillDir = path.join(tmpWorkspace, '.agents', 'skills', 'my-real-skill');
        fs.mkdirSync(skillDir, { recursive: true });

        const skillFile = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(
            skillFile,
            [
                '---',
                'name: my-real-skill',
                'description: A reproducible test skill.',
                '---',
                '',
                '# My Real Skill',
                'Use this for validation.',
            ].join('\n'),
            'utf-8'
        );

        try {
            const loader = new SkillsLoader(tmpWorkspace);
            const tools = loader.getTools() as Record<string, { execute: (input: any) => Promise<string> }>;
            const output = await tools.Skill.execute({ skill_id: 'my-real-skill' });

            expect(output).toContain('My Real Skill');
            expect(output).toContain('name: "my-real-skill"');
            expect(output).toContain(`${path.sep}SKILL.md`);
            if (path.sep === "\\") {
                expect(output).not.toContain('/SKILL.md');
            } else {
                expect(output).not.toContain('\\SKILL.md');
            }

            const summary = await loader.getSummaryOfAllSkills('my-real-skill');
            expect(summary).toContain('my-real-skill');
            expect(summary).toContain('(active)');
        } finally {
            fs.rmSync(tmpWorkspace, { recursive: true, force: true });
        }
    });

    it('can resolve a skill by metadata name even when skill id path differs', async () => {
        const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-loader-name-'));
        const skillDir = path.join(tmpWorkspace, '.agents', 'skills', 'folder-id');
        fs.mkdirSync(skillDir, { recursive: true });

        const skillFile = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(
            skillFile,
            [
                '---',
                'name: human-facing-name',
                'description: Skill loaded by display name.',
                '---',
                '',
                '# Name Resolution Skill',
                'Validation content.',
            ].join('\n'),
            'utf-8'
        );

        try {
            const loader = new SkillsLoader(tmpWorkspace);
            const tools = loader.getTools() as Record<string, { execute: (input: any) => Promise<string> }>;
            const output = await tools.Skill.execute({ skill_id: 'human-facing-name' });

            expect(output).toContain('Name Resolution Skill');
            expect(output).toContain('name: "human-facing-name"');
        } finally {
            fs.rmSync(tmpWorkspace, { recursive: true, force: true });
        }
    });
});
