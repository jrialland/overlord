import path from "path";
import { glob } from "glob";
import fs from "fs";
import os from "os";
import { logger } from "../logging";
import yaml from "js-yaml";
import { type Tool, type ToolSet } from "ai";
import { z } from 'zod';
import { normalizeFsPath, toGlobPattern } from "../path-utils";

/**
 * Reads markdown content and optional YAML front matter from a skill file.
 */
async function loadMarkdownWithFrontMatter(filePath: string): Promise<{ content: string; metadata: Record<string, unknown> }> {
    const fileContent = await fs.promises.readFile(filePath, 'utf-8');
    const frontMatterMatch = fileContent.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    let metadata: Record<string, unknown> = {};
    let content = fileContent;
    if (frontMatterMatch) {
        const frontMatter = frontMatterMatch[1];
        metadata = yaml.load(frontMatter!) as Record<string, unknown>;
        content = fileContent.slice(frontMatterMatch[0].length).trim();
    }
    return { content, metadata };
}

/**
 * In-memory representation of one loaded skill.
 */
class Skill {
    constructor(public skillId: string, public location: string, public content: string, public metadata: Record<string, unknown>) {
    }

    /**
     * Loads and validates a skill markdown file.
     */
    static async load(skillId: string, skillMdPath: string): Promise<Skill> {
        const { content, metadata } = await loadMarkdownWithFrontMatter(skillMdPath);

        // metadata must contain a name field
        if (!metadata.name || typeof metadata.name !== 'string') {
            throw new Error(`Skill at ${skillMdPath} is missing a valid "name" field in its metadata`);
        }

        const name = metadata.name.trim();
        if (name === "") {
            throw new Error(`Skill at ${skillMdPath} has an empty "name" field in its metadata`);
        }

        // name must be <= 64 characters
        if (name.length > 64) {
            throw new Error(`Skill at ${skillMdPath} has a "name" field that is too long (max 64 characters)`);
        }

        // name must be a lowercase identifier
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
            throw new Error(`Skill at ${skillMdPath} has a "name" field that is not a valid lowercase identifier (only lowercase letters, numbers, and dashes are allowed)`);
        }

        // description field is mandatory and must be a string
        if (!metadata.description || typeof metadata.description !== 'string') {
            throw new Error(`Skill at ${skillMdPath} is missing a valid "description" field in its metadata`);
        }
        const description = metadata.description?.trim().replace(/\s+/g, ' ') ?? "";
        if (description === "") {
            throw new Error(`Skill at ${skillMdPath} has an empty "description" field in its metadata`);
        }

        // description must be <= 1024 characters
        if (description.length > 1024) {
            throw new Error(`Skill at ${skillMdPath} has a "description" field that is too long (max 1024 characters)`);
        }

        return new Skill(skillId, normalizeFsPath(skillMdPath), content, metadata);
    }

    /**
     * Validated skill display name.
     */
    get name(): string {
        return (this.metadata.name as string).trim();
    }

    /**
     * One-line normalized description used in skill listings.
     */
    get description(): string {
        return (this.metadata.description as string).trim().replace(/\s+/g, ' ');
    }

}

/**
 * Discovers, loads, validates, and exposes skills as tools.
 */
export class SkillsLoader {

    private loadedSkills: { [key: string]: Skill } = {};
    private skillsLoaded = false;
    private loadingPromise: Promise<void> | null = null;

    constructor(private workspace: string) {

    }

    private async ensureSkillsLoaded(): Promise<void> {
        if (this.skillsLoaded) {
            return;
        }
        if (this.loadingPromise) {
            await this.loadingPromise;
            return;
        }
        this.loadingPromise = this.loadAllSkills();
        try {
            await this.loadingPromise;
        } finally {
            this.loadingPromise = null;
        }
    }

    private resolveSkillId(input: string): string {
        const candidate = input.trim();
        if (candidate === "") {
            throw new Error("Skill id cannot be empty");
        }

        if (this.loadedSkills[candidate]) {
            return candidate;
        }

        const normalized = candidate.toLowerCase();
        for (const [skillId, skill] of Object.entries(this.loadedSkills)) {
            if (skillId.toLowerCase() === normalized) {
                return skillId;
            }
            if (skill.name.toLowerCase() === normalized) {
                return skillId;
            }
        }

        throw new Error(`Skill with id or name '${input}' not found`);
    }

    /**
     * Returns directories scanned for skill packs in priority order.
     */
    getScannedDirs(): string[] {
        const home = os.homedir();
        const scanned: string[] = [
            path.join(home, ".agents", "skills"), // in ~/.agents/skills
            path.join(home, ".config", "overlord", "skills"), //  in ~/.config/overlord/skills
            path.join(this.workspace, ".agents", "skills"), //  in .agents/skills
            path.join(this.workspace, ".overlord", "skills") // in the workspace .overlord/skills

        ];
        return scanned.filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
    }

    /**
     * Loads all SKILL.md files in a directory tree.
     */
    async loadSkillsFromDir(dir: string): Promise<{ [key: string]: Skill }> {
        // walk the directory looking for SKILL.md files
        const loadedInThisDir: { [key: string]: Skill } = {};
        const pattern = toGlobPattern(path.join(dir, "**", "SKILL.md"));
        for (const skillFile of await glob(pattern)) {
            try {
                const relativePath = path.relative(dir, path.dirname(skillFile));
                const skillId = relativePath.replace(/\\/g, '/'); // Normalize Windows paths
                const skill = await Skill.load(skillId, skillFile);
                if (this.loadedSkills[relativePath]) {
                    logger.warn({ file: skillFile, existing: this.loadedSkills[relativePath].location }, 'Skill will replace an already loaded skill with the same id');
                }
                loadedInThisDir[skillId] = skill;
                logger.info({ file: skillFile }, 'Loaded skill');
            } catch (error) {
                logger.error({ file: skillFile, error: String(error) }, 'Error loading skill');
            }
        }

        return loadedInThisDir;
    }

    /**
     * Refreshes the global skill cache from all configured skill directories.
     */
    async loadAllSkills(): Promise<void> {
        const newSkills: { [key: string]: Skill } = {};
        const scannedDirs = this.getScannedDirs();
        logger.info({ scannedDirs }, 'Scanning for skills in directories');
        for (const dir of scannedDirs) {
            const loadedInDir = await this.loadSkillsFromDir(dir);
            Object.assign(newSkills, loadedInDir);
        }
        this.loadedSkills = newSkills;
        this.skillsLoaded = true;
        logger.info({ count: Object.keys(this.loadedSkills).length }, 'Finished loading skills');
    }

    /**
     * Returns one skill payload including a metadata preamble.
     */
    async getSkillContent(skillId: string, invokedFromPrompt: boolean = false): Promise<string> {
        await this.ensureSkillsLoaded();
        const resolvedSkillId = this.resolveSkillId(skillId);
        const skill = this.loadedSkills[resolvedSkillId];
        if (!skill) {
            throw new Error(`Skill with id '${resolvedSkillId}' not found after resolution`);
        }
        let result = "";
        if (invokedFromPrompt) {
            result += ` > For the '${skill.name}' skill loaded from '${skill.location}' \n`.replace("'", "`");
            result += ` > ⚠️ Paths are relative to ${path.dirname(skill.location)} in this section.\n`;
        }
        else {
            result += "---\n";
            result += `name: "${skill.name}"\n`;
            result += `file: "${skill.location}" → ⚠️ Paths are relative to ${path.dirname(skill.location)} in this section\n`;
            result += "---\n\n";
        }
        result += skill.content;
        return result;
    }

    /**
     * Builds a markdown summary table of all loaded skills.
     */
    async getSummaryOfAllSkills(activeSkill?: string): Promise<string> {
        await this.ensureSkillsLoaded();
        const skills = this.loadedSkills;
        const count = Object.keys(skills).length;
        if (count === 0) {
            return '';
        }

        let result = `
                > Skills are task - specific capabilities that you can activate on demand. 

{ { skill_count } }. When activating a skill, you are reprompted with specific knowledge and instructions about the described topic.
Activate a skill by invoking the \`Skill(<skill_id>)\` tool if relevant.

| skill_id | Description |
|----------|-------------|
`;
        let resolvedActiveSkillId: string | undefined;
        if (activeSkill) {
            try {
                resolvedActiveSkillId = this.resolveSkillId(activeSkill);
            } catch {
                resolvedActiveSkillId = undefined;
            }
        }

        for (const skillId in this.loadedSkills) {
            const skill = this.loadedSkills[skillId];
            const isActive = skillId === resolvedActiveSkillId;
            if (isActive) {
                result += `| **${skillId}** (active) | **${skill!.description}** |\n`;
            } else {
                result += `| ${skillId} | ${skill!.description} |\n`;
            }
        }

        result += "\n";

        const replacement = count === 1 ? "There is currently one available skill" : `There are ${count} available skills`;

        return result.replace("{{skill_count}}", replacement);
    }


    /**
     * Exposes skill operations as tools.
     */
    getTools(): ToolSet {
        return {
            "Skill": {
                description: "View the content of a skill by its id. Use this to understand what a skill does and how to use it before activating it.",
                inputSchema: z.object({
                    skill_id: z.string().describe("The id of the skill to view.")
                }),
                execute: async (input: { skill_id: string }) => {
                    const { skill_id } = input;
                    return await this.getSkillContent(skill_id);
                }
            } as Tool,
            "ListAvailableSkills": {
                description: "List all available skills with a brief description. Use this to discover what skills are available to activate.",
                inputSchema: z.object({}),
                execute: async () => {
                    return await this.getSummaryOfAllSkills();
                }
            } as Tool
        };
    }

}

