import { logger } from "../logging";

/**
 * A typed pub/sub channel for a single event family.
 *
 * A topic owns a set of asynchronous subscribers and provides a minimal API for
 * registering callbacks, removing them, and publishing messages to all current
 * subscribers.
 *
 * Delivery semantics:
 * - Subscribers are invoked sequentially, in subscription order.
 * - `publish` waits for each subscriber before moving to the next one.
 * - Subscriber failures are isolated and logged; one failing subscriber does not
 *   prevent delivery to the remaining subscribers.
 * - Subscription identity is represented by an opaque string returned from
 *   `subscribe`.
 *
 * `EventType` should describe the exact payload shape published on this topic.
 */
export interface Topic<EventType> {
    /**
     * Register an asynchronous subscriber.
     *
     * @param callback Callback invoked for each future message published on this topic.
     * @returns An opaque subscription ID that can later be passed to `unsubscribe`.
     */
    subscribe(callback: (message: EventType) => Promise<void>): string;

    /**
     * Remove a previously registered subscriber.
     *
     * Implementations should treat unknown subscription IDs as a no-op.
     *
     * @param subscriberId The opaque ID returned by `subscribe`.
     */
    unsubscribe(subscriberId: string): void;

    /**
     * Publish a message to all current subscribers.
     *
     * Implementations are expected to handle subscriber failures internally so
     * callers can treat publication as best-effort fan-out.
     *
     * @param message The typed event payload to deliver.
     */
    publish(message: EventType): Promise<void>;
}

/**
 * A no-op topic implementation.
 *
 * This is useful as a safe default dependency when a component wants to emit
 * events but should remain functional even when no real event pipeline is
 * configured. Subscriptions are ignored and published messages are dropped.
 */
class _NullTopic<EventType> implements Topic<EventType> {
    /**
     * Ignore the subscription request and return an empty subscription ID.
     */
    subscribe(_callback: (message: EventType) => Promise<void>): string {
        return "";
    }

    /**
     * Ignore unsubscription requests.
     */
    unsubscribe(_subscriberId: string): void {
    }

    /**
     * Drop the message without performing any work.
     */
    async publish(_message: EventType): Promise<void> {
    }
}

/**
 * Shared no-op topic instance.
 *
 * Use this as a default constructor argument when a caller may optionally inject
 * a real topic later. The exported value is intentionally permissive and can be
 * cast to a more specific `Topic<T>` where needed.
 */
export const NullTopic = new _NullTopic<any>();

/**
 * Default in-memory topic implementation used by {@link Bus}.
 *
 * Topics are created lazily by the bus and automatically removed once their last
 * subscriber unsubscribes. This keeps the bus lightweight for short-lived or
 * sparsely used event types.
 */
class TopicImpl<EventType> implements Topic<EventType> {

    private subscribers: Map<string, (message: EventType) => Promise<void>> = new Map();

    /**
     * @param eventType Logical event name used as the topic key in the parent bus.
     * @param bus Parent bus instance that owns this topic.
     */
    constructor(private eventType: string, private bus: Bus) {
    }

    /**
     * Register a subscriber and return its generated subscription ID.
     */
    subscribe(callback: (message: EventType) => Promise<void>): string {
        const subscriberId = crypto.randomUUID();
        this.subscribers.set(subscriberId, callback);
        return subscriberId;
    }

    /**
     * Remove a subscriber from this topic.
     *
     * When the final subscriber is removed, the topic unregisters itself from the
     * parent bus so unused topics do not accumulate indefinitely.
     */
    unsubscribe(subscriberId: string): void {
        this.subscribers.delete(subscriberId);
        if (this.subscribers.size === 0) {
            this.bus.deleteTopic(this.eventType);
        }
    }

    /**
     * Deliver a message to all subscribers.
     *
     * Delivery is sequential and resilient to subscriber errors. Failures are
     * logged with the message payload for diagnostics.
     */
    async publish(message: EventType): Promise<void> {
        for (const subscriber of this.subscribers.values()) {
            try {
                await subscriber(message);
            } catch (err) {
                logger.error({ message, error: err }, 'Error processing message in topic subscriber');
            }
        }
    }
}

/**
 * In-memory registry of named topics.
 *
 * The bus provides a lightweight pub/sub mechanism inside the process. Topics are
 * looked up by string key and are created lazily the first time `getTopic` is
 * called. Subsequent lookups for the same key return the same topic instance.
 *
 * This implementation is intentionally simple:
 * - it does not persist messages,
 * - it does not replay past events to late subscribers,
 * - it does not provide cross-process delivery.
 *
 * It is intended for internal coordination between modules that need decoupled,
 * typed event exchange.
 */
export class Bus {

    private subscriptions: Map<string, TopicImpl<any>> = new Map();

    /**
     * Create an empty bus.
     */
    constructor() {
    }

    /**
     * Get the topic associated with an event type, creating it on demand.
     *
     * Callers are responsible for using a consistent `EventType` for a given
     * `eventType` string across the codebase.
     *
     * @param eventType Unique name of the event family.
     * @returns A reusable topic instance for the provided event name.
     */
    getTopic<EventType>(eventType: string): Topic<EventType> {
        if (!this.subscriptions.has(eventType)) {
            this.subscriptions.set(eventType, new TopicImpl<EventType>(eventType, this));
        }
        return this.subscriptions.get(eventType)!;
    }

    /**
     * Remove a topic from the registry.
     *
     * This is primarily used internally by `TopicImpl` when its last subscriber is
     * removed, but it is exposed so alternative topic-management strategies remain
     * possible.
     *
     * @param eventType Unique name of the topic to remove.
     */
    deleteTopic(eventType: string): void {
        this.subscriptions.delete(eventType);
    }

}

const globalBusInstance = new Bus();

/**
 * Return the process-wide shared bus instance.
 *
 * Prefer constructor injection for modules that should remain easy to test or
 * isolate. Use `globalBus()` when a singleton event hub is acceptable for the
 * current runtime.
 */
export const globalBus = () => globalBusInstance;