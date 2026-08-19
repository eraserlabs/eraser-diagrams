export type PriorityComparator<T> = (a: T, b: T) => number;

/**
 * Perf-optimized binary min-heap with O(log n) push and pop operations.
 *
 * Numeric priority is always primary. Callers that need canonical ordering for
 * equal-priority values can provide a comparator that runs only on exact ties.
 */
export class PriorityQueue<T> {
  private values: T[] = [];
  private priorities = new Float64Array(1024);
  private len = 0;

  constructor(private readonly compareTies?: PriorityComparator<T>) {}

  get length(): number {
    return this.len;
  }

  push(value: T, priority: number): void {
    let index = this.len++;
    if (index >= this.priorities.length) {
      this.grow();
    }

    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentPriority = this.priorities[parent];
      if (priority > parentPriority) {
        break;
      }
      if (
        priority === parentPriority &&
        (!this.compareTies || this.compareTies(value, this.values[parent]) >= 0)
      ) {
        break;
      }
      this.values[index] = this.values[parent];
      this.priorities[index] = this.priorities[parent];
      index = parent;
    }

    this.values[index] = value;
    this.priorities[index] = priority;
  }

  pop(): T | undefined {
    if (this.len === 0) {
      return undefined;
    }

    const min = this.values[0];
    const value = this.values[--this.len];
    const priority = this.priorities[this.len];
    let index = 0;
    let child = 1;

    while (child < this.len) {
      if (child + 1 < this.len) {
        const right = child + 1;
        const leftPriority = this.priorities[child];
        const rightPriority = this.priorities[right];
        if (
          rightPriority < leftPriority ||
          (rightPriority === leftPriority &&
            this.compareTies &&
            this.compareTies(this.values[right], this.values[child]) <= 0)
        ) {
          child = right;
        }
      }

      const childPriority = this.priorities[child];
      if (priority < childPriority) {
        break;
      }
      if (
        priority === childPriority &&
        (!this.compareTies || this.compareTies(value, this.values[child]) <= 0)
      ) {
        break;
      }
      this.values[index] = this.values[child];
      this.priorities[index] = this.priorities[child];
      index = child;
      child = (child << 1) + 1;
    }

    this.values[index] = value;
    this.priorities[index] = priority;
    return min;
  }

  isEmpty(): boolean {
    return this.len === 0;
  }

  getSize(): number {
    return this.len;
  }

  peek(): T | undefined {
    return this.len > 0 ? this.values[0] : undefined;
  }

  private grow(): void {
    const oldCapacity = this.priorities.length;
    const newCapacity = oldCapacity > 0 ? oldCapacity << 1 : 16;
    const priorities = new Float64Array(newCapacity);
    priorities.set(this.priorities);
    this.priorities = priorities;
    this.values.length = newCapacity;
  }
}
