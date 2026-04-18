/**
 * A 'process' is a class that has a name and an execute method that returns output.
 * A 'processManager' starts processes, exposes methods to check their status, and retrieves output when complete.
 * Processes are executed asynchronously and tracked with unique IDs.
 * Supports cancellation, timeout, and error handling for robust lifecycle management.
 */
import { type Topic, NullTopic } from "../bus";

export const PROCESS_LIFECYCLE_TOPIC = "process.lifecycle";

export type ProcessStatus = "idle" | "processing" | "completed" | "failed" | "cancelled";

export type ProcessLifecycleEventType = "registered" | "scheduled" | "started" | "completed" | "failed" | "cancelled";

export interface ProcessLifecycleEvent {
    type: ProcessLifecycleEventType;
    processId?: string;
    processName: string;
    description?: string;
    status: ProcessStatus | "registered" | "scheduled";
    occurredAt: string;
    timeoutMs?: number;
    result?: unknown;
    error?: {
        name: string;
        message: string;
    };
}

interface ProcessOptions {
    /**
     * Optional timeout in milliseconds. Process will be aborted if it exceeds this duration.
     */
    timeoutMs?: number;
}

export interface Process {
    name: string;
    description?: string;
    /**
     * Execute the process. Should return the final output/result.
     * Can check the abort signal to gracefully handle cancellation.
     */
    execute(signal?: AbortSignal): Promise<any>;
}

interface ProcessContainer {
    id: string;
    name: string;
    description?: string;
    status: ProcessStatus;
    result?: any;
    error?: Error;
    startTime?: Date;
    endTime?: Date;
    abortController: AbortController;
}

type ProcessListener = (container: ProcessContainer) => void;

export class ProcessManager {
    private processes: Map<string, ProcessContainer> = new Map();
    private statusListeners: Set<ProcessListener> = new Set();
    private processDefinitions: Map<string, Process> = new Map();

    constructor(
        private readonly lifecycleTopic: Topic<ProcessLifecycleEvent> = NullTopic as Topic<ProcessLifecycleEvent>
    ) {
    }

    /**
     * Register a process definition that can be instantiated and run.
     */
    registerProcess(process: Process): void {
        if (this.processDefinitions.has(process.name)) {
            throw new Error(`Process with name ${process.name} is already registered.`);
        }
        this.processDefinitions.set(process.name, process);
        void this.emitLifecycleEvent({
            type: "registered",
            processName: process.name,
            description: process.description,
            status: "registered",
            occurredAt: new Date().toISOString(),
        });
    }

    /**
     * Run a registered process asynchronously and track its lifecycle.
     * @param processName - Name of the registered process to run
     * @param options - Optional configuration (timeout, etc.)
     * @returns A unique process instance ID
     */
    runProcess(processName: string, options: ProcessOptions = {}): string {
        const process = this.processDefinitions.get(processName);
        if (!process) {
            throw new Error(`Process ${processName} is not registered.`);
        }

        const id = this.generateProcessId(processName);
        const abortController = new AbortController();
        const container: ProcessContainer = {
            id,
            name: process.name,
            description: process.description,
            status: "idle",
            abortController,
        };

        this.processes.set(id, container);
        void this.notifyListeners(container);
        void this.emitLifecycleEvent({
            type: "scheduled",
            processId: id,
            processName: container.name,
            description: container.description,
            status: "scheduled",
            occurredAt: new Date().toISOString(),
            timeoutMs: options.timeoutMs,
        });

        // Start the process execution in the background without awaiting
        this.executeProcessInBackground(process, container, options);

        return id;
    }

    private async executeProcessInBackground(
        process: Process,
        container: ProcessContainer,
        options: ProcessOptions
    ): Promise<void> {
        // Handle timeout if specified
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (options.timeoutMs && options.timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                if (container.status === "processing") {
                    container.abortController.abort();
                }
            }, options.timeoutMs);
        }

        try {
            container.status = "processing";
            container.startTime = new Date();
            await this.notifyListeners(container);

            container.result = await process.execute(container.abortController.signal);
            container.status = "completed";
        } catch (err) {
            if (container.abortController.signal.aborted) {
                container.status = "cancelled";
                container.error = err instanceof Error ? err : new Error("Process was cancelled");
            } else {
                container.status = "failed";
                container.error = err instanceof Error ? err : new Error(String(err));
            }
        } finally {
            container.endTime = new Date();
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            await this.notifyListeners(container);
        }
    }

    /**
     * Get the current status of a running or completed process.
     */
    getProcessStatus(processId: string): ProcessContainer | null {
        return this.processes.get(processId) || null;
    }

    /**
     * Get the result of a completed process. Returns null if still processing or failed.
     */
    getProcessResult(processId: string): any {
        const container = this.processes.get(processId);
        if (!container || container.status !== "completed") {
            return null;
        }
        return container.result;
    }

    /**
     * Cancel a running process.
     */
    cancelProcess(processId: string): boolean {
        const container = this.processes.get(processId);
        if (!container) {
            return false;
        }
        if (container.status === "processing") {
            container.abortController.abort();
            return true;
        }
        return false;
    }

    /**
     * Wait for a process to complete (successfully, fail, or be cancelled).
     */
    async waitForProcess(processId: string): Promise<ProcessContainer | null> {
        const container = this.processes.get(processId);
        if (!container) {
            return null;
        }

        return new Promise((resolve) => {
            const checkCompletion = () => {
                if (
                    container.status === "completed" ||
                    container.status === "failed" ||
                    container.status === "cancelled"
                ) {
                    this.statusListeners.delete(listener);
                    resolve(container);
                }
            };

            const listener: ProcessListener = checkCompletion;
            this.statusListeners.add(listener);
            checkCompletion(); // Check immediately in case already complete
        });
    }

    /**
     * Subscribe to process status changes.
     */
    onStatusChange(listener: ProcessListener): () => void {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    /**
     * Get a summary of all managed processes.
     */
    toMarkdown(): string {
        let markdown = `| ID | Name | Description | Status | Duration | Result | Error |\n`;
        markdown += `|----|------|-------------|--------|----------|--------|-------|\n`;

        this.processes.forEach((container) => {
            const description = container.description || "";
            const duration =
                container.startTime && container.endTime
                    ? `${container.endTime.getTime() - container.startTime.getTime()}ms`
                    : "-";
            const result =
                container.status === "completed"
                    ? typeof container.result === "string"
                        ? container.result
                        : JSON.stringify(container.result).substring(0, 50)
                    : "-";
            const error = container.error ? container.error.message : "-";
            const truncatedId = container.id.substring(0, 8);
            markdown += `| ${truncatedId}... | ${container.name} | ${description} | ${container.status} | ${duration} | ${result} | ${error} |\n`;
        });

        return markdown;
    }

    /**
     * List all registered process definitions.
     */
    listRegisteredProcesses(): Array<{ name: string; description?: string }> {
        return Array.from(this.processDefinitions.values()).map((process) => ({
            name: process.name,
            description: process.description,
        }));
    }

    /**
     * Clear completed processes to free memory.
     */
    clearCompleted(): number {
        let cleared = 0;
        for (const [id, container] of this.processes.entries()) {
            if (container.status === "completed" || container.status === "failed" || container.status === "cancelled") {
                this.processes.delete(id);
                cleared++;
            }
        }
        return cleared;
    }

    private generateProcessId(processName: string): string {
        return `${processName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    private async notifyListeners(container: ProcessContainer): Promise<void> {
        this.statusListeners.forEach((listener) => {
            try {
                listener(container);
            } catch (err) {
                console.error("Error in process listener:", err);
            }
        });

        const lifecycleType = this.getLifecycleEventType(container.status);
        if (lifecycleType) {
            await this.emitLifecycleEvent({
                type: lifecycleType,
                processId: container.id,
                processName: container.name,
                description: container.description,
                status: container.status,
                occurredAt: new Date().toISOString(),
                result: container.status === "completed" ? container.result : undefined,
                error: container.error
                    ? {
                        name: container.error.name,
                        message: container.error.message,
                    }
                    : undefined,
            });
        }
    }

    private getLifecycleEventType(status: ProcessStatus): Exclude<ProcessLifecycleEventType, "registered" | "scheduled"> | null {
        switch (status) {
            case "processing":
                return "started";
            case "completed":
                return "completed";
            case "failed":
                return "failed";
            case "cancelled":
                return "cancelled";
            case "idle":
                return null;
        }
    }

    private async emitLifecycleEvent(event: ProcessLifecycleEvent): Promise<void> {
        await this.lifecycleTopic.publish(event);
    }
}