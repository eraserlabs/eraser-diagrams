import { PriorityQueue } from '../PriorityQueue.js';

describe('PriorityQueue', () => {
  it('orders values by numeric push priority', () => {
    const queue = new PriorityQueue<string>();
    queue.push('third', 3);
    queue.push('first', 1);
    queue.push('second', 2);

    expect(queue.length).toBe(3);
    expect(queue.peek()).toBe('first');
    expect([queue.pop(), queue.pop(), queue.pop(), queue.pop()]).toEqual([
      'first',
      'second',
      'third',
      undefined,
    ]);
    expect(queue.isEmpty()).toBe(true);
  });

  it('uses a value comparator only to break numeric-priority ties', () => {
    interface Item {
      cost: number;
      key: string;
    }
    const queue = new PriorityQueue<Item>((a, b) => a.key.localeCompare(b.key));
    queue.push({ cost: 1, key: 'b' }, 1);
    queue.push({ cost: 0, key: 'z' }, 0);
    queue.push({ cost: 1, key: 'a' }, 1);

    expect([queue.pop()?.key, queue.pop()?.key, queue.pop()?.key]).toEqual(['z', 'a', 'b']);
  });

  it('grows beyond its initial numeric-priority capacity', () => {
    const queue = new PriorityQueue<number>();
    for (let value = 1_100; value >= 0; value--) {
      queue.push(value, value);
    }
    for (let expected = 0; expected <= 1_100; expected++) {
      expect(queue.pop()).toBe(expected);
    }
  });
});
