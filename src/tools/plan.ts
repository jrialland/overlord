
import { z } from "zod";
import type { Tool, ToolSet } from "ai";


export interface Task {
    title: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    comments: string[];
    createdAt: Date;
    updatedAt: Date;
}

const statusAliases: Map<string, string> = new Map([
    ["inprogress", "in_progress"],
    ["current", "in_progress"],
    ["doing", "in_progress"],
    ["todo", "pending"],
    ["tbd", "pending"],
    ["done", "completed"],
    ["complete", "completed"],
    ["finished", "completed"],
    ["cancel", "cancelled"],
    ["canceled", "cancelled"],
    ["✅", "completed"],
    ["⏳", "in_progress"],
    ["❌", "cancelled"]
]);

/**
 * Best effort to normalize status input to one of the accepted statuses, using the statusAliases map. If no match is found, default to "pending".
 * some models might return status updates in various formats, so this function helps to standardize them to our defined set of statuses.
 * @param status 
 * @returns 
 */
function normalizeStatus(status: string): Task["status"] | null {
    if(["pending", "in_progress", "completed", "cancelled"].includes(status as Task["status"])) {
        return status as Task["status"];
    }
    const normalizedStatus = status.toLowerCase().replace(/\s+/g, "_");
    if(statusAliases.has(normalizedStatus)) {
        return statusAliases.get(normalizedStatus) as Task["status"];
    } else {
        return null;
    }
}

export class PlanTools {

    private tasks: Task[] = [];

    createTask(title: string): string {
        const newTask: Task = {
            title,
            status: "pending",
            comments: [],
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.tasks.push(newTask);
        return `Task ${this.tasks.length} created`;
    }

    viewTask(taskNumber: number): string {
        const task = this.tasks[taskNumber - 1];
        if(!task) {
            return `Task ${taskNumber} does not exist.`;
        }
        const statusEmoji = task.status === "completed" ? "✅" : task.status === "in_progress" ? "⏳" : task.status === "cancelled" ? "❌" : " ";
        const isFinished = ["completed", "cancelled"].includes(task.status);
        let markdown = "";
        let statusLine = "";
            if (isFinished) {
                statusLine = `- [${statusEmoji}]  _Task ${taskNumber}: ${task.title} _(${task.status.charAt(0).toUpperCase() + task.status.slice(1)})_`;
            } else {
                statusLine = `- [${statusEmoji}]  Task ${taskNumber}: **${task.title}**`;
            }
            markdown += statusLine + "\n";
            if (task.comments.length > 0) {
                markdown += `  - Comments:\n`;
                task.comments.forEach(comment => {
                    markdown += isFinished ? `    - _${comment}_\n` : `    - ${comment}\n`;
                });
            }
        return markdown;
    }

    updateTaskStatus(taskNumber: number, status: string, comment?: string): string | null {
        const task = this.tasks[taskNumber - 1];
        const normalizedStatus = normalizeStatus(status);
        if(normalizedStatus === null) {
            return `Status "${status}" is not recognized. Valid statuses are: pending, in_progress, completed, cancelled.`;
        }
        if (task) {
            task.status = normalizedStatus;
            if (comment) {
                task.comments.push(comment);
            }
            task.updatedAt = new Date();
            return `Task ${taskNumber} updated`;
        }
        return `Task ${taskNumber} does not exist.`;
    }
    

    toMarkdown(): string {
        if(this.tasks.length === 0) {
            return "There are no active tasks. Use the CreateTodo tool to add new tasks to the list.";
        }
        let markdown = "";
        this.tasks.forEach((task, index) => {
            markdown += this.viewTask(index + 1) + "\n";
        });
        return markdown;
    }

    hasPendingTasks(): boolean {
        return this.tasks.some(task => task.status === "pending");
    }

    isFinished(): boolean {
        return this.tasks.every(task => ["completed", "cancelled"].includes(task.status));
    }

    clearTasks(): void {
        this.tasks = [];
    }

    /**
     * TaskCreate, TaskList, TaskStop, TaskUpdate, TodoWrite
     * @returns 
     */
    getToolSet(): ToolSet {

        return {
            "ListTodos": {
                description: "Lists all currently active tasks with their status and metadata.",
                inputSchema: z.object({}),
                execute: async () => this.toMarkdown()
            } as Tool,
            "CreateTodo": {
                description: "Create a new task with a given title. The task will be initialized with a 'pending' status.",
                inputSchema: z.object({
                    title: z.string().describe("The title of the task to create.")
                }),
                execute: async ({ title }) => this.createTask(title)
            } as Tool,
            "UpdateTodoStatus": {
                description: "Update the status of an existing task. Optionally, a comment can be added to provide context for the status change.",
                inputSchema: z.object({
                    taskNumber: z.number().describe("The rank of the task to update, starting from 1."),
                    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("The new status for the task."),
                    comment: z.string().optional().describe("An optional comment to add when updating the task status.")
                }),
                execute: async ({ taskNumber, status, comment }) => this.updateTaskStatus(taskNumber, status, comment)
            } as Tool,
            "ClearTodos": {
                description: "Clear all tasks from the list, resetting the task manager to an empty state.",
                inputSchema: z.object({}),
                execute: async () => this.clearTasks()
            } as Tool,
        };
    }
}