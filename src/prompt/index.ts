import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { SkillsLoader } from '../skills';
import Handlebars from 'handlebars';
import { PlanTools } from '../tools/plan';
import { logger } from '../logging';

interface PromptVariables {
    activeSkill?: string;
    currentMode?: string;
    [key: string]: any;
}

interface PromptSection {
    name: string;
    getContent(vars?: PromptVariables): Promise<string | undefined>;
}

class MarkdownSection implements PromptSection {
    workspace: string;
    name: string;
    sources: string[];
    interpolate: boolean;

    constructor(name: string, workspace: string, sources: string[], interpolate = false) {
        this.name = name;
        this.workspace = workspace;
        this.sources = sources;
        this.interpolate = interpolate;
    }

    private async resolveSource(source: string): Promise<string | null> {
        try {
            if (source.startsWith('~')) {
                const homePath = path.join(os.homedir(), source.slice(1));
                await fs.access(homePath);
                return homePath;
            }
            const sourcePath = path.join(this.workspace, 'prompt', source);
            await fs.access(sourcePath);
            return sourcePath;
        } catch (error) {
            return null;
        }
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        // Find the last existing source (reverse order means workspace overrides home)
        for (const source of this.sources.slice().reverse()) {
            const resolvedPath = await this.resolveSource(source);
            if (resolvedPath) {
                try {
                    let content = await fs.readFile(resolvedPath, 'utf-8');
                    if (this.interpolate && vars) {
                        try {
                            const template = Handlebars.compile(content);
                            content = template(vars);
                        } catch (error) {
                            logger.warn({ err: error, resolvedPath }, 'Failed to interpolate template');
                            return undefined;
                        }
                    }
                    return content || undefined;
                } catch (error) {
                    logger.warn({ err: error, resolvedPath }, 'Failed to read markdown section');
                    return undefined;
                }
            }
        }
        return undefined;
    }
}

class StaticSection implements PromptSection {
    name: string;
    content: string;

    constructor(name: string, content: string) {
        this.name = name;
        this.content = content;
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        return this.content;
    }
}

class SkillSummarySection implements PromptSection {
    name: string;
    private skillsLoader: SkillsLoader;

    constructor(name: string, skillsLoader: SkillsLoader) {
        this.name = name;
        this.skillsLoader = skillsLoader;
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        const activeSkill = vars?.activeSkill;
        try {
            return await this.skillsLoader.getSummaryOfAllSkills(activeSkill);
        } catch (error) {
            logger.warn({ err: error, activeSkill }, 'Failed to get skills summary');
            return undefined;
        }
    }
}

class ActiveSkillSection implements PromptSection {
    name: string;
    private skillsLoader: SkillsLoader;

    constructor(name: string, skillsLoader: SkillsLoader) {
        this.name = name;
        this.skillsLoader = skillsLoader;
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        const activeSkillId = vars?.activeSkill;
        if (!activeSkillId) {
            return undefined;
        }
        try {
            return await this.skillsLoader.getSkillContent(activeSkillId, true);
        } catch (error) {
            logger.warn({ err: error, activeSkillId }, 'Failed to load active skill');
            return undefined;
        }
    }
}

class CurrentModeSection implements PromptSection {
    name: string;

    constructor(name: string) {
        this.name = name;
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        if (!vars?.currentMode) {
            return undefined;
        }
        if(vars.currentMode === 'agent') {
            return "You are currently in **agent mode**. In this mode, You can plan, or directly execute tasks in order to complete the assigned task.";
        }
        if(vars.currentMode === 'plan') {
            return "You are currently in **plan mode**. In this mode, you should focus on elaborating a comprehensive plan to complete the assigned task, using the \"*Todo*\" tools. Then, you can switch to agent mode to execute the plan step by step, updating the status of each task as you progress.";
        }
        return `You are currently in **${vars.currentMode} mode**.`;
    }
}

class CurrentPlanSection implements PromptSection {
    name: string;
    private planTools: PlanTools;

    constructor(name: string, planTools: PlanTools) {
        this.name = name;
        this.planTools = planTools;
    }

    async getContent(vars?: PromptVariables): Promise<string | undefined> {
        try {
            if (this.planTools.hasPendingTasks()) {
                return this.planTools.toMarkdown();
            }
            if (this.planTools.isFinished()) {
                this.planTools.clearTasks();
            }
            return undefined;
        } catch (error) {
            logger.warn({ err: error }, 'Failed to get current plan');
            return undefined;
        }
    }
}


export class PromptTemplate {

    private sections: Map<string, PromptSection> = new Map();

    addSection(section: PromptSection): void {
        this.sections.set(section.name, section);
    }

    async render(vars?: PromptVariables): Promise<string> {
        let result = '';
        const count = this.sections.size;
        if (count === 0) {
            return result;
        }
        for (const section of this.sections.values()) {
            try {
                const content = await section.getContent(vars);
                if (content) {
                    result += `## ${section.name}\n\n`;
                    result += content + '\n';
                }
            } catch (error) {
                logger.warn({ err: error, sectionName: section.name }, 'Failed to render section');
            }
        }
        return result;
    }

    /**
     * Creates a comprehensive prompt template for the main agent.
     * Includes system information, user context, available skills, and current tasks.
     * @param workspace - The workspace root directory
     * @param planTools - Optional plan/task tracker for including current tasks
     */
    static makeAgentTemplate(workspace: string, planTools?: PlanTools): PromptTemplate {
        const template = new PromptTemplate();
        const skillsLoader = new SkillsLoader(workspace);

        // System information with variable interpolation (e.g., current date, OS)
        template.addSection(new MarkdownSection('System informations', workspace, ['~/.overlord/SYSTEM.md'], true));

        // Agent identity/personality, loaded from workspace or home directory
        template.addSection(new MarkdownSection('About you', workspace, ["~/.overlord/SOUL.md", path.join(workspace, '.overlord/SOUL.md')], true));

        // User information and preferences
        template.addSection(new MarkdownSection('About the user', workspace, ['~/.overlord/USER.md', path.join(workspace, '.overlord/USER.md')], true));

        // General agent instructions from workspace
        template.addSection(new MarkdownSection('General Instructions', workspace, [path.join(workspace, 'AGENTS.md'), path.join(workspace, '.claude/CLAUDE.md')], false));

        // Dynamic list of available skills
        template.addSection(new SkillSummarySection('Available Skills', skillsLoader));

        // Detailed content of the currently active skill
        template.addSection(new ActiveSkillSection('Active Skill', skillsLoader));

        // Current mode/context section
        template.addSection(new CurrentModeSection('Current Mode'));

        // Current plan/tasks if provided
        if (planTools) {
            template.addSection(new CurrentPlanSection('Your Current Plan', planTools));
        }

        return template;
    }

    /**
     * Creates a simplified prompt template for sub-agents.
     * Focuses on the assigned task and relevant skills without broader system/user context.
     * Use this when delegating specific tasks to sub-agents to keep prompts concise.
     * @param workspace - The workspace root directory
     * @param instructions - The specific task instructions for this sub-agent
     * @param planTools - Optional plan/task tracker for including current tasks
     */
    static makeSubAgentTemplate(workspace: string, instructions: string, planTools?: PlanTools): PromptTemplate {
        const template = new PromptTemplate();
        const skillsLoader = new SkillsLoader(workspace);

        // General agent instructions from workspace
        template.addSection(new MarkdownSection('General Instructions', workspace, [path.join(workspace, 'AGENTS.md'), path.join(workspace, '.claude/CLAUDE.md')], false));

        // Detailed content of the currently active skill
        template.addSection(new ActiveSkillSection('Active Skill', skillsLoader));

        // The specific task assigned to this sub-agent
        if (instructions) {
            template.addSection(new StaticSection('Assigned Task', instructions));
        }

        // Current mode/context section
        template.addSection(new CurrentModeSection('Current Mode'));

        // Current plan/tasks if provided
        if (planTools) {
            template.addSection(new CurrentPlanSection('Your Current Plan', planTools));
        }

        return template;
    }
}