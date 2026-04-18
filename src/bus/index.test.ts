import { describe, expect, it } from 'bun:test';

import { Bus, globalBus, NullTopic, type Topic } from './index';

describe('Bus', () => {
    it('returns the same topic instance for the same event type', () => {
        const bus = new Bus();

        const firstTopic = bus.getTopic<{ value: number }>('numbers');
        const secondTopic = bus.getTopic<{ value: number }>('numbers');

        expect(firstTopic).toBe(secondTopic);
    });

    it('delivers published messages to subscribers in subscription order', async () => {
        const bus = new Bus();
        const topic = bus.getTopic<string>('ordered-events');
        const received: string[] = [];

        topic.subscribe(async (message) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            received.push(`first:${message}`);
        });

        topic.subscribe(async (message) => {
            received.push(`second:${message}`);
        });

        await topic.publish('payload');

        expect(received).toEqual([
            'first:payload',
            'second:payload',
        ]);
    });

    it('continues publishing when one subscriber throws', async () => {
        const bus = new Bus();
        const topic = bus.getTopic<string>('resilient-events');
        const received: string[] = [];

        topic.subscribe(async () => {
            throw new Error('subscriber failure');
        });

        topic.subscribe(async (message) => {
            received.push(message);
        });

        await expect(topic.publish('still-delivered')).resolves.toBeUndefined();
        expect(received).toEqual(['still-delivered']);
    });

    it('stops delivering messages to unsubscribed handlers', async () => {
        const bus = new Bus();
        const topic = bus.getTopic<number>('unsubscribe-events');
        let received = 0;

        const subscriberId = topic.subscribe(async (value) => {
            received += value;
        });

        topic.unsubscribe(subscriberId);
        await topic.publish(5);

        expect(received).toBe(0);
    });

    it('removes empty topics so later lookups create a new instance', () => {
        const bus = new Bus();
        const firstTopic = bus.getTopic<string>('ephemeral-events');
        const subscriptionId = firstTopic.subscribe(async () => {
        });

        firstTopic.unsubscribe(subscriptionId);

        const secondTopic = bus.getTopic<string>('ephemeral-events');
        expect(secondTopic).not.toBe(firstTopic);
    });

    it('ignores unknown subscription IDs when unsubscribing', async () => {
        const bus = new Bus();
        const topic = bus.getTopic<string>('unknown-unsubscribe');
        const received: string[] = [];

        topic.subscribe(async (message) => {
            received.push(message);
        });

        topic.unsubscribe('does-not-exist');
        await topic.publish('ok');

        expect(received).toEqual(['ok']);
    });
});

describe('NullTopic', () => {
    it('acts as a no-op topic', async () => {
        const nullTopic = NullTopic as Topic<{ message: string }>;

        const subscriptionId = nullTopic.subscribe(async () => {
            throw new Error('should not be called');
        });

        expect(subscriptionId).toBe('');
        nullTopic.unsubscribe('anything');
        await expect(nullTopic.publish({ message: 'ignored' })).resolves.toBeUndefined();
    });
});

describe('globalBus', () => {
    it('returns the same shared bus instance', () => {
        expect(globalBus()).toBe(globalBus());
    });
});