import { describe, expect, it } from 'bun:test';

import { PlanTools } from './plan';

describe('PlanTools', () => {
    it('creates tasks with pending status and timestamps', () => {
        const tools = new PlanTools("test_workspace");

        const result = tools.createTask('Investigate project structure');

        expect(result).toBe('Task 1 created');

        const taskMarkdown = tools.viewTask(1);
        expect(taskMarkdown).toContain('Task 1: **Investigate project structure**');
        expect(taskMarkdown).toContain('- [ ]');
    });

    it('normalizes status aliases when updating tasks directly', () => {
        const tools = new PlanTools("test_workspace");
        tools.createTask('Run integration checks');

        const updateResult = tools.updateTaskStatus(1, 'done', 'Checks are green');

        expect(updateResult).toBe('Task 1 updated');

        const taskMarkdown = tools.viewTask(1);
        expect(taskMarkdown).toContain('_(Completed)_');
        expect(taskMarkdown).toContain('Checks are green');
    });

    it('returns a specific message when updating with an unknown status', () => {
        const tools = new PlanTools("test_workspace");
        tools.createTask('Draft release notes');

        const updateResult = tools.updateTaskStatus(1, 'blocked');

        expect(updateResult).toBe('Status "blocked" is not recognized. Valid statuses are: pending, in_progress, completed, cancelled.');
    });

    it('returns a specific message when updating an invalid task index', () => {
        const tools = new PlanTools("test_workspace");

        const updateResult = tools.updateTaskStatus(42, 'completed');

        expect(updateResult).toBe('Task 42 does not exist.');
    });

    it('renders markdown with status markers and comments', () => {
        const tools = new PlanTools("test_workspace");
        tools.createTask('Plan milestones');
        tools.createTask('Archive obsolete ideas');

        tools.updateTaskStatus(1, 'in_progress', 'Milestone draft started');
        tools.updateTaskStatus(2, 'cancelled', 'No longer relevant');

        const markdown = tools.toMarkdown();

        expect(markdown).toContain('- [⏳]  Task 1: **Plan milestones**');
        expect(markdown).toContain('Milestone draft started');
        expect(markdown).toContain('No longer relevant');
    });

    it('clears all tasks', () => {
        const tools = new PlanTools("test_workspace");
        tools.createTask('One');
        tools.createTask('Two');

        tools.clearTasks();

        expect(tools.toMarkdown()).toContain('There are no active tasks');
    });

    it('exposes a working toolset for agentic planning workflows', async () => {
        const tools = new PlanTools("test_workspace");
        const toolset = tools.getToolSet();

        expect(Object.keys(toolset).sort()).toEqual([
            'ClearTodos',
            'CreateTodo',
            'ListTodos',
            'UpdateTodoStatus'
        ]);

        const createResult = await toolset.CreateTodo?.execute?.({ title: 'Collect requirements' });
        expect(createResult).toBe('Task 1 created');

        const updateResult = await toolset.UpdateTodoStatus?.execute?.({
            taskNumber: 1,
            status: 'completed',
            comment: 'Reviewed and finalized',
        });
        expect(updateResult).toBe('Task 1 updated');

        const listed = await toolset.ListTodos?.execute?.({});
        expect(typeof listed).toBe('string');
        expect(listed).toContain('- [✅]  _Task 1: Collect requirements _');
        expect(listed).toContain('Reviewed and finalized');

        await toolset.ClearTodos?.execute?.({});
        expect(tools.toMarkdown()).toContain('There are no active tasks');
    });
});
