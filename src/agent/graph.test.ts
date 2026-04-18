import { describe, expect, it } from 'bun:test';
import { Graph } from './graph';

type State = { value: number; log: string[] };

function makeState(value = 0, log: string[] = []): State {
    return { value, log: [...log] };
}

describe('Graph', () => {

    describe('valid', () => {
        it('is invalid when empty (no path from START to END)', () => {
            const g = new Graph<State>("Test Graph");
            expect(g.valid).toBe(false);
        });

        it('is valid when START connects directly to END', () => {
            const g = new Graph<State>("Test Graph");
            g.addEdge(g.START, g.END);
            expect(g.valid).toBe(true);
        });

        it('is valid with an intermediate node', () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('a', async (s) => s);
            g.addEdge(g.START, 'a');
            g.addEdge('a', g.END);
            expect(g.valid).toBe(true);
        });

        it('is invalid when intermediate node does not reach END', () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('a', async (s) => s);
            g.addEdge(g.START, 'a');
            // no edge from 'a' to END
            expect(g.valid).toBe(false);
        });
    });

    describe('addNode', () => {
        it('adds a node that can be used in edges', () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('a', async (s) => s);
            // should not throw when creating edge to it
            g.addEdge(g.START, 'a');
        });

        it('throws when using reserved START name', () => {
            const g = new Graph<State>("Test Graph");
            expect(() => g.addNode(g.START, async (s) => s)).toThrow('reserved');
        });

        it('throws when using reserved END name', () => {
            const g = new Graph<State>("Test Graph");
            expect(() => g.addNode(g.END, async (s) => s)).toThrow('reserved');
        });
    });

    describe('addEdge', () => {
        it('throws when source node does not exist', () => {
            const g = new Graph<State>("Test Graph");
            expect(() => g.addEdge('nonexistent', g.END)).toThrow('does not exist');
        });

        it('throws when target node does not exist', () => {
            const g = new Graph<State>("Test Graph");
            expect(() => g.addEdge(g.START, 'nonexistent')).toThrow('does not exist');
        });
    });

    describe('addConditionalEdge', () => {
        it('throws when source node does not exist', () => {
            const g = new Graph<State>("Test Graph");
            expect(() => g.addConditionalEdge('nonexistent', () => 'a', { a: g.END })).toThrow('does not exist');
        });

        it('throws when a mapping target does not exist', () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('a', async (s) => s);
            expect(() =>
                g.addConditionalEdge('a', () => 'x', { x: 'nonexistent' })
            ).toThrow('does not exist');
        });
    });

    describe('execute', () => {
        it('throws on an invalid graph', async () => {
            const g = new Graph<State>("Test Graph");
            expect(g.execute(makeState())).rejects.toThrow('invalid graph');
        });

        it('executes a trivial START -> END graph', async () => {
            const g = new Graph<State>("Test Graph");
            g.addEdge(g.START, g.END);
            const result = await g.execute(makeState(42));
            expect(result.value).toBe(42);
        });

        it('executes a linear chain of nodes', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('double', async (s) => ({ ...s, value: s.value * 2, log: [...s.log, 'double'] }));
            g.addNode('addOne', async (s) => ({ ...s, value: s.value + 1, log: [...s.log, 'addOne'] }));
            g.addEdge(g.START, 'double');
            g.addEdge('double', 'addOne');
            g.addEdge('addOne', g.END);

            const result = await g.execute(makeState(5));
            expect(result.value).toBe(11); // (5 * 2) + 1
            expect(result.log).toEqual(['double', 'addOne']);
        });

        it('follows conditional edges based on state', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('check', async (s) => s);
            g.addNode('positive', async (s) => ({ ...s, log: [...s.log, 'positive'] }));
            g.addNode('negative', async (s) => ({ ...s, log: [...s.log, 'negative'] }));

            g.addEdge(g.START, 'check');
            g.addConditionalEdge(
                'check',
                (s) => s.value >= 0 ? 'pos' : 'neg',
                { pos: 'positive', neg: 'negative' }
            );
            g.addEdge('positive', g.END);
            g.addEdge('negative', g.END);

            const pos = await g.execute(makeState(10));
            expect(pos.log).toEqual(['positive']);

            const neg = await g.execute(makeState(-5));
            expect(neg.log).toEqual(['negative']);
        });

        it('throws when conditional choice returns unknown key', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('decide', async (s) => s);
            g.addNode('a', async (s) => s);

            g.addEdge(g.START, 'decide');
            g.addConditionalEdge(
                'decide',
                () => 'unknown_key',
                { a: 'a' }
            );
            g.addEdge('a', g.END);

            expect(g.execute(makeState())).rejects.toThrow('not a valid key');
        });

        it('supports a loop via conditional edges', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('increment', async (s) => ({
                ...s,
                value: s.value + 1,
                log: [...s.log, `inc(${s.value + 1})`],
            }));

            g.addEdge(g.START, 'increment');
            g.addConditionalEdge(
                'increment',
                (s) => s.value >= 3 ? 'done' : 'again',
                { done: g.END, again: 'increment' }
            );

            const result = await g.execute(makeState(0));
            expect(result.value).toBe(3);
            expect(result.log).toEqual(['inc(1)', 'inc(2)', 'inc(3)']);
        });
    });

    describe('addSubgraphNode', () => {
        it('throws when subgraph is invalid', () => {
            const g = new Graph<State>("Test Graph");
            const sub = new Graph<State>("Subgraph"); // no edges → invalid
            expect(() => g.addSubgraphNode('sub', sub)).toThrow('not valid');
        });

        it('throws when using reserved name', () => {
            const g = new Graph<State>("Test Graph");
            const sub = new Graph<State>("Subgraph");
            sub.addEdge(sub.START, sub.END);
            expect(() => g.addSubgraphNode(g.START, sub)).toThrow('reserved');
        });

        it('executes a subgraph node as part of the parent graph', async () => {
            const sub = new Graph<State>("Subgraph");
            sub.addNode('triple', async (s) => ({ ...s, value: s.value * 3, log: [...s.log, 'triple'] }));
            sub.addEdge(sub.START, 'triple');
            sub.addEdge('triple', sub.END);

            const g = new Graph<State>("Test Graph");
            g.addNode('addTen', async (s) => ({ ...s, value: s.value + 10, log: [...s.log, 'addTen'] }));
            g.addSubgraphNode('sub', sub);
            g.addEdge(g.START, 'addTen');
            g.addEdge('addTen', 'sub');
            g.addEdge('sub', g.END);

            const result = await g.execute(makeState(2));
            // (2 + 10) * 3 = 36
            expect(result.value).toBe(36);
            expect(result.log).toEqual(['addTen', 'triple']);
        });
    });

    describe('clone', () => {
        it('produces an independent copy that executes identically', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('double', async (s) => ({ ...s, value: s.value * 2 }));
            g.addEdge(g.START, 'double');
            g.addEdge('double', g.END);

            const cloned = g.clone();

            const original = await g.execute(makeState(7));
            const fromClone = await cloned.execute(makeState(7));
            expect(fromClone.value).toBe(original.value);
        });

        it('cloned graph is independent from original', async () => {
            const g = new Graph<State>("Test Graph");
            g.addNode('a', async (s) => ({ ...s, value: s.value + 1 }));
            g.addEdge(g.START, 'a');
            g.addEdge('a', g.END);

            const cloned = g.clone();
            // Add a new node to the original — the clone should be unaffected
            g.addNode('b', async (s) => ({ ...s, value: s.value + 100 }));

            const result = await cloned.execute(makeState(0));
            expect(result.value).toBe(1);
        });

        it('clones a graph containing a subgraph node', async () => {
            const sub = new Graph<State>("Test Graph");
            sub.addNode('inc', async (s) => ({ ...s, value: s.value + 1 }));
            sub.addEdge(sub.START, 'inc');
            sub.addEdge('inc', sub.END);

            const g = new Graph<State>("Test Graph");
            g.addSubgraphNode('sub', sub);
            g.addEdge(g.START, 'sub');
            g.addEdge('sub', g.END);

            const cloned = g.clone();
            const result = await cloned.execute(makeState(10));
            expect(result.value).toBe(11);
        });
    });
});
