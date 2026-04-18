import { describe, expect, it } from 'bun:test';
import { Bus } from '../bus';
import { ProcessManager, PROCESS_LIFECYCLE_TOPIC, type ProcessLifecycleEvent } from './index';

const defaultTimeout = 15000;

describe('ProcessManager', () => {
    it('registers and lists process definitions', () => {
        const manager = new ProcessManager();

        const process = {
            name: 'greet',
            description: 'Greets a user',
            execute: async () => 'Hello!',
        };

        manager.registerProcess(process);

        const registered = manager.listRegisteredProcesses();
        expect(registered).toHaveLength(1);
        expect(registered[0]?.name).toBe('greet');
        expect(registered[0]?.description).toBe('Greets a user');
    });

    it('prevents duplicate process registration', () => {
        const manager = new ProcessManager();

        const process = {
            name: 'duplicate',
            execute: async () => 'result',
        };

        manager.registerProcess(process);

        expect(() => manager.registerProcess(process)).toThrow('already registered');
    });

    it('runs a simple process and returns a process ID', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'simple',
            execute: async () => 'done',
        });

        const processId = manager.runProcess('simple');
        expect(processId).toBeTruthy();
        expect(processId).toContain('simple-');
    });

    it('tracks process status through execution lifecycle', async () => {
        const manager = new ProcessManager();
        let executionStarted = false;

        manager.registerProcess({
            name: 'lifecycle',
            execute: async () => {
                executionStarted = true;
                await new Promise((r) => setTimeout(r, 50));
                return 'complete';
            },
        });

        const processId = manager.runProcess('lifecycle');
        const completed = await manager.waitForProcess(processId);

        expect(completed?.status).toBe('completed');
        expect(completed?.result).toBe('complete');
        expect(executionStarted).toBe(true);
    });

    it('captures process results', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'result-process',
            execute: async () => ({ count: 42, items: ['a', 'b'] }),
        });

        const processId = manager.runProcess('result-process');
        await manager.waitForProcess(processId);

        const result = manager.getProcessResult(processId);
        expect(result).toEqual({ count: 42, items: ['a', 'b'] });
    });

    it('handles process errors and stores error message', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'failing',
            execute: async () => {
                throw new Error('Intentional failure');
            },
        });

        const processId = manager.runProcess('failing');
        const status = await manager.waitForProcess(processId);

        expect(status?.status).toBe('failed');
        expect(status?.error?.message).toBe('Intentional failure');
        expect(manager.getProcessResult(processId)).toBeNull();
    });

    it('enforces timeout and cancels long-running processes', async () => {
        const manager = new ProcessManager();
        let processAborted = false;

        manager.registerProcess({
            name: 'long-running',
            execute: async (signal) => {
                await new Promise<void>((_resolve, reject) => {
                    const handle = setTimeout(() => {
                        reject(new Error('timeout'));
                    }, 5000);

                    signal?.addEventListener('abort', () => {
                        clearTimeout(handle);
                        processAborted = true;
                        reject(new Error('aborted'));
                    }, { once: true });
                });
            },
        });

        const processId = manager.runProcess('long-running', { timeoutMs: 100 });
        const status = await manager.waitForProcess(processId);

        expect(status?.status).toBe('cancelled');
        expect(processAborted).toBe(true);
    }, defaultTimeout);

    it('manually cancels a running process', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'cancellable',
            execute: async (signal) => {
                // Simulate a process that takes time
                await new Promise((r) => setTimeout(r, 500));
                if (signal?.aborted) {
                    throw new Error('Process was aborted');
                }
                return 'completed';
            },
        });

        // Start the process (returns immediately now)
        const processId = manager.runProcess('cancellable');
        
        // Cancel it while it's running
        const cancelled = manager.cancelProcess(processId);
        
        // Verify cancellation worked
        expect(cancelled).toBe(true);
    });

    it('returns null for non-existent process status', () => {
        const manager = new ProcessManager();
        const status = manager.getProcessStatus('non-existent-id');
        expect(status).toBeNull();
    });

    it('returns null for non-existent process result', () => {
        const manager = new ProcessManager();
        const result = manager.getProcessResult('non-existent-id');
        expect(result).toBeNull();
    });

    it('tracks start and end times for processes', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'timed',
            execute: async () => {
                await new Promise((r) => setTimeout(r, 100));
                return 'done';
            },
        });

        const processId = manager.runProcess('timed');
        const status = await manager.waitForProcess(processId);

        const startTime = status?.startTime;
        const endTime = status?.endTime;

        expect(startTime).toBeInstanceOf(Date);
        expect(endTime).toBeInstanceOf(Date);

        if (!startTime || !endTime) {
            throw new Error('Expected process timestamps to be set');
        }

        expect(endTime.getTime()).toBeGreaterThanOrEqual(startTime.getTime());
    });

    it('notifies listeners on status changes', async () => {
        const manager = new ProcessManager();
        const events: Array<string> = [];

        manager.onStatusChange((container) => {
            events.push(container.status);
        });

        manager.registerProcess({
            name: 'observed',
            execute: async () => 'result',
        });

        manager.runProcess('observed');
        await new Promise((r) => setTimeout(r, 100)); // Wait for async execution

        expect(events).toContain('processing');
        expect(events).toContain('completed');
    });

    it('allows unsubscribing from status changes', async () => {
        const manager = new ProcessManager();
        const events: Array<string> = [];

        const unsubscribe = manager.onStatusChange((container) => {
            events.push(container.status);
        });

        unsubscribe();

        manager.registerProcess({
            name: 'unobserved',
            execute: async () => 'result',
        });

        manager.runProcess('unobserved');
        await new Promise((r) => setTimeout(r, 100)); // Wait for async execution

        expect(events).toHaveLength(0);
    });

    it('clears completed processes and frees memory', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'clearable',
            execute: async () => 'done',
        });

        const id1 = manager.runProcess('clearable');
        const id2 = manager.runProcess('clearable');

        await manager.waitForProcess(id1);
        await manager.waitForProcess(id2);

        const cleared = manager.clearCompleted();
        expect(cleared).toBe(2);

        expect(manager.getProcessStatus(id1)).toBeNull();
        expect(manager.getProcessStatus(id2)).toBeNull();
    });

    it('generates markdown summary of all processes', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'test-process',
            description: 'A test process',
            execute: async () => 'success',
        });

        const processId = manager.runProcess('test-process');
        await manager.waitForProcess(processId);

        const markdown = manager.toMarkdown();

        expect(markdown).toContain('| ID | Name | Description | Status | Duration | Result | Error |');
        expect(markdown).toContain('test-process');
        expect(markdown).toContain('A test process');
        expect(markdown).toContain('completed');
        expect(markdown).toContain('success');
    });

    it('runs multiple processes in parallel and tracks independently', async () => {
        const manager = new ProcessManager();

        manager.registerProcess({
            name: 'parallel-task',
            execute: async (signal) => {
                const delay = Math.random() * 100;
                await new Promise((r) => setTimeout(r, delay));
                return `completed after ${delay}ms`;
            },
        });

        const ids = [
            manager.runProcess('parallel-task'),
            manager.runProcess('parallel-task'),
            manager.runProcess('parallel-task'),
        ];

        const results = await Promise.all(ids.map((id) => manager.waitForProcess(id)));

        expect(results).toHaveLength(3);
        expect(results.every((r) => r?.status === 'completed')).toBe(true);
        expect(results.every((r) => typeof r?.result === 'string')).toBe(true);
    });

    it('emits structured lifecycle events on the global bus', async () => {
        const bus = new Bus();
        const topic = bus.getTopic<ProcessLifecycleEvent>(PROCESS_LIFECYCLE_TOPIC);
        const manager = new ProcessManager(topic);
        const events: ProcessLifecycleEvent[] = [];
        const subscriptionId = topic.subscribe(async (event) => {
                events.push(event);
            });

        try {
            manager.registerProcess({
                name: 'bus-observed',
                description: 'Publishes lifecycle events',
                execute: async () => 'ok',
            });

            const processId = manager.runProcess('bus-observed', { timeoutMs: 250 });
            await manager.waitForProcess(processId);
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(events.map((event) => event.type)).toEqual([
                'registered',
                'scheduled',
                'started',
                'completed',
            ]);

            const scheduledEvent = events[1];
            expect(scheduledEvent?.processId).toBe(processId);
            expect(scheduledEvent?.processName).toBe('bus-observed');
            expect(scheduledEvent?.status).toBe('scheduled');
            expect(scheduledEvent?.timeoutMs).toBe(250);

            const completedEvent = events[3];
            expect(completedEvent?.status).toBe('completed');
            expect(completedEvent?.result).toBe('ok');
            expect(completedEvent?.error).toBeUndefined();
        } finally {
            topic.unsubscribe(subscriptionId);
        }
    });
});
