import { DirectedGraph } from "graphology";
import { dijkstra } from 'graphology-shortest-path';
import { logger } from "../logging";

class NodeData<StateT> {

    public nextNodeMapping: Record<string, string> = {};

    public nextNodeChooser: ((state: StateT) => string) = (_) => { throw new Error("No next node chooser function defined for this node") };

    constructor(public id: string, public action: (state: StateT) => Promise<StateT>) {
    }

    get isSubgraphNode(): boolean {
        return false;
    }
}

class SubgraphNodeData<StateT> extends NodeData<StateT> {

    constructor(id: string, public subgraph: Graph<StateT>) {
        super(id, (state: StateT) => subgraph.execute(state));
    }

    override get isSubgraphNode(): boolean {
        return true;
    }
}

class EdgeData {
    constructor(public label: string | undefined = undefined) {
    }
}

/**
 * Optional lifecycle hooks that can observe graph execution.
 */
export class GraphPlugin<StateT> {
    constructor(public name: string) {
    }

    /** Called once before execution starts. */
    onGraphExecutionStart(graph: Graph<StateT>, state: StateT): void {
        // can be overridden by subclasses
    }

    /** Called once after execution ends. */
    onGraphExecutionEnd(graph: Graph<StateT>, state: StateT): void {
        // can be overridden by subclasses
    }

    /** Called before each node action is invoked. */
    beforeNodeExecution(graph: Graph<StateT>, nodeId: string, state: StateT): void {
        // can be overridden by subclasses
    }

    /** Called after each node action completes. */
    afterNodeExecution(graph: Graph<StateT>, nodeId: string, state: StateT): void {
        // can be overridden by subclasses
    }

    /** Called before traversing an edge between nodes. */
    beforeEdgeTraversal(graph: Graph<StateT>, fromNodeId: string, toNodeId: string, state: StateT): void {
        // can be overridden by subclasses
    }

    /** Called after traversing an edge between nodes. */
    afterEdgeTraversal(graph: Graph<StateT>, fromNodeId: string, toNodeId: string, state: StateT): void {
        // can be overridden by subclasses
    }

}

/**
 * Minimal directed graph runtime for stateful async workflows.
 */
export class Graph<StateT> {

    readonly START = "●";

    readonly END = "⊙";

    private graph: DirectedGraph = new DirectedGraph();

    /**
     * Produces a serialization-safe state preview for debug logging.
     */
    private safeStatePreview(state: StateT): unknown {
        if (state === null || state === undefined) {
            return state;
        }
        if (typeof state !== 'object') {
            return state;
        }
        try {
            return JSON.parse(JSON.stringify(state));
        } catch {
            return { type: typeof state, note: 'State could not be JSON-serialized' };
        }
    }

    /**
     * Creates a graph with reserved START/END sentinel nodes.
     */
    constructor(public name: string) {
        this.graph.addNode(this.START, { data: new NodeData(this.START, async (state: StateT) => state) });
        this.graph.addNode(this.END, { data: new NodeData(this.END, async (state: StateT) => state) });
        logger.debug({ graph: this.name, start: this.START, end: this.END }, 'Initialized graph');
    }

    /**
     * considering that a graph is valid if we can somehow connect the START node to the END node
     */
    get valid(): boolean {
        try {
            const path = dijkstra.bidirectional(this.graph, this.START, this.END);
            const isValid = path.length > 0;
            logger.debug({ graph: this.name, isValid, pathLength: path.length, path }, 'Evaluated graph validity');
            return isValid;
        } catch {
            logger.debug({ graph: this.name }, 'Graph validity check failed');
            return false;
        }
    }

    /**
     * Adds a normal executable node.
     */
    addNode(node: string, action: (state: StateT) => Promise<StateT>): void {
        if ([this.START, this.END].includes(node)) {
            logger.error({ graph: this.name, node }, 'Attempted to add reserved node name');
            throw new Error(`Node name "${node}" is reserved and cannot be used`);
        }
        this.graph.addNode(node, { data: new NodeData(node, action) });
        logger.debug({ graph: this.name, node, totalNodes: this.graph.order }, 'Added node');
    }

    /**
     * Adds a subgraph as a node so nested workflows can be composed.
     */
    addSubgraphNode(node: string, subgraph: Graph<StateT>): void {
        if ([this.START, this.END].includes(node)) {
            logger.error({ graph: this.name, node }, 'Attempted to add reserved subgraph node name');
            throw new Error(`Node name "${node}" is reserved and cannot be used`);
        }
        if (!subgraph.valid) {
            logger.error({ graph: this.name, node, subgraph: subgraph.name }, 'Attempted to add invalid subgraph node');
            throw new Error(`Subgraph is not valid and cannot be added as a node`);
        }
        this.graph.addNode(node, { data: new SubgraphNodeData(node, subgraph) });
        logger.debug({ graph: this.name, node, subgraph: subgraph.name, totalNodes: this.graph.order }, 'Added subgraph node');
    }

    /**
     * Simple unconditonal transition from one node to another.
     * @param from The node from which the edge originates
     * @param to The node to which the edge points
     */
    addEdge(from: string, to: string): void {
        if (!this.graph.hasNode(from)) {
            logger.error({ graph: this.name, from, to }, 'Attempted to add edge with missing source node');
            throw new Error(`Node "${from}" does not exist in the graph`);
        }
        if (!this.graph.hasNode(to)) {
            logger.error({ graph: this.name, from, to }, 'Attempted to add edge with missing target node');
            throw new Error(`Node "${to}" does not exist in the graph`);
        }
        const nodeAttr = this.graph.getNodeAttribute(from, 'data') as NodeData<StateT>;
        nodeAttr.nextNodeMapping[to] = to;
        nodeAttr.nextNodeChooser = (state: StateT) => to;
        this.graph.addEdge(from, to, { data: new EdgeData() });
        logger.debug({ graph: this.name, from, to, totalEdges: this.graph.size }, 'Added edge');
    }

    /**
     * Conditional transition: the node to follow is determined at runtime by the choiceFunction, which returns a key that is looked up in the mapping to determine the next node.
     * 
     * Example:
     * ```typescript
     * graph.addConditionalEdge(
     *    "invokeModel",
     *    (state) => state.lastMessage.hasToolCalls ? "hasToolCalls" : "noToolCalls",
     *   {
     *     "hasToolCalls": "processToolCalls",
     *     "noToolCalls": "END"
     *   }
     * );
     * ```
     * 
     * @param from 
     * @param choiceFunction 
     * @param mapping 
     */
    addConditionalEdge(from: string, choiceFunction: (state: StateT) => string, mapping: Record<string, string>): void {
        if (!this.graph.hasNode(from)) {
            logger.error({ graph: this.name, from }, 'Attempted to add conditional edge with missing source node');
            throw new Error(`Node "${from}" does not exist in the graph`);
        }
        for (const to of Object.values(mapping)) {
            if (!this.graph.hasNode(to)) {
                logger.error({ graph: this.name, from, to, mapping }, 'Attempted to add conditional edge with missing target node');
                throw new Error(`Node "${to}" does not exist in the graph`);
            }
        }
        const nodeAttr = this.graph.getNodeAttribute(from, 'data') as NodeData<StateT>;
        nodeAttr.nextNodeMapping = mapping;
        nodeAttr.nextNodeChooser = (state: StateT) => {
            const choiceKey = choiceFunction(state);
            const nextNode = mapping[choiceKey]
            if (!nextNode) {
                logger.error({ graph: this.name, from, choiceKey, mapping, state: this.safeStatePreview(state) }, 'Choice function returned an unknown key');
                throw new Error(`Choice function returned "${choiceKey}" which is not a valid key in the mapping for node "${from}"`);
            }
            logger.trace({ graph: this.name, from, choiceKey, nextNode, state: this.safeStatePreview(state) }, 'Resolved conditional edge');
            return nextNode;
        };
        for (const [fromKey, to] of Object.entries(mapping)) {
            this.graph.addEdge(from, to, { data: new EdgeData(fromKey) });
        }
        logger.debug({ graph: this.name, from, mapping, totalEdges: this.graph.size }, 'Added conditional edges');
    }

    /**
     * Executes from START until END while mutating and returning state.
     */
    async execute(state: StateT, plugins: GraphPlugin<StateT>[] = []): Promise<StateT> {
        if (!this.valid) {
            logger.error({ graph: this.name }, 'Attempted to execute an invalid graph');
            throw new Error("Cannot execute an invalid graph");
        }
        let currentNode = this.START;
        let currentState = state;

        logger.debug(
            {
                graph: this.name,
                startNode: this.START,
                endNode: this.END,
                pluginCount: plugins.length,
                initialState: this.safeStatePreview(currentState),
            },
            'Starting graph execution'
        );

        for (const plugin of plugins) {
            plugin.onGraphExecutionStart(this, currentState);
            logger.trace({ graph: this.name, plugin: plugin.name }, 'Ran onGraphExecutionStart plugin hook');
        }

        let steps = 0;
        while (currentNode !== this.END) {
            steps += 1;
            const nodeAttr = this.graph.getNodeAttribute(currentNode, 'data') as NodeData<StateT>;

            logger.debug(
                {
                    graph: this.name,
                    step: steps,
                    node: currentNode,
                    stateBefore: this.safeStatePreview(currentState),
                },
                'Executing node'
            );

            for (const plugin of plugins) {
                plugin.beforeNodeExecution(this, currentNode, currentState);
                logger.trace({ graph: this.name, plugin: plugin.name, node: currentNode }, 'Ran beforeNodeExecution plugin hook');
            }

            currentState = await nodeAttr.action(currentState);

            logger.debug(
                {
                    graph: this.name,
                    step: steps,
                    node: currentNode,
                    stateAfter: this.safeStatePreview(currentState),
                },
                'Completed node execution'
            );

            for (const plugin of plugins) {
                plugin.afterNodeExecution(this, currentNode, currentState);
                logger.trace({ graph: this.name, plugin: plugin.name, node: currentNode }, 'Ran afterNodeExecution plugin hook');
            }

            const fromNode = currentNode;
            currentNode = nodeAttr.nextNodeChooser!(currentState);

            logger.debug(
                {
                    graph: this.name,
                    step: steps,
                    fromNode,
                    toNode: currentNode,
                    state: this.safeStatePreview(currentState),
                },
                'Traversing edge'
            );

            for (const plugin of plugins) {
                plugin.beforeEdgeTraversal(this, nodeAttr.id, currentNode, currentState);
                logger.trace({ graph: this.name, plugin: plugin.name, fromNode: nodeAttr.id, toNode: currentNode }, 'Ran beforeEdgeTraversal plugin hook');
                plugin.afterEdgeTraversal(this, nodeAttr.id, currentNode, currentState);
                logger.trace({ graph: this.name, plugin: plugin.name, fromNode: nodeAttr.id, toNode: currentNode }, 'Ran afterEdgeTraversal plugin hook');
            }
        }

        for (const plugin of plugins) {
            plugin.onGraphExecutionEnd(this, currentState);
            logger.trace({ graph: this.name, plugin: plugin.name }, 'Ran onGraphExecutionEnd plugin hook');
        }

        logger.debug(
            {
                graph: this.name,
                steps,
                finalState: this.safeStatePreview(currentState),
            },
            'Finished graph execution'
        );

        return currentState;
    }

    /**
     * Deep-clones graph topology and node routing metadata.
     */
    clone(): Graph<StateT> {
        logger.debug({ graph: this.name, nodeCount: this.graph.order, edgeCount: this.graph.size }, 'Cloning graph');
        const newGraph = new Graph<StateT>(this.name);
        this.graph.forEachNode((node, attributes) => {
            if (![this.START, this.END].includes(node)) {
                const nodeData = attributes.data as NodeData<StateT>;
                if (nodeData.isSubgraphNode) {
                    const subgraphNodeData = nodeData as SubgraphNodeData<StateT>;
                    newGraph.addSubgraphNode(node, subgraphNodeData.subgraph.clone());
                } else {
                    newGraph.addNode(node, nodeData.action);
                }
            }
        });
        for (const edge of this.graph.edges()) {
            const from = this.graph.source(edge);
            const to = this.graph.target(edge);
            const edgeData = this.graph.getEdgeAttribute(edge, 'data') as EdgeData;
            newGraph.graph.addEdge(from, to, { data: edgeData });
        }
        // Copy nextNodeMapping and nextNodeChooser from the original nodes
        this.graph.forEachNode((node, attributes) => {
            const srcData = attributes.data as NodeData<StateT>;
            const dstData = newGraph.graph.getNodeAttribute(node, 'data') as NodeData<StateT>;
            dstData.nextNodeMapping = { ...srcData.nextNodeMapping };
            dstData.nextNodeChooser = srcData.nextNodeChooser;
        });
        logger.debug({ graph: this.name, clonedNodeCount: newGraph.graph.order, clonedEdgeCount: newGraph.graph.size }, 'Finished cloning graph');
        return newGraph;
    }
}