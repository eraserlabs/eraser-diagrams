import type { AxisSpan } from '../../types.js';
import type { Corridor } from './contract.js';

/** Immutable, axis-relative bounds indexed by corridor-array position. */
export class CorridorSpans {
  readonly xIndices: readonly number[];
  readonly yIndices: readonly number[];
  readonly travelStarts: Readonly<Int32Array | Float64Array>;
  readonly travelEnds: Readonly<Int32Array | Float64Array>;
  readonly crossStarts: Readonly<Int32Array | Float64Array>;
  readonly crossEnds: Readonly<Int32Array | Float64Array>;

  constructor(corridors: readonly Corridor[]) {
    // Production coordinates are whole pixels. Preserve fractional, signed-zero,
    // and out-of-range geometry supplied by standalone callers as well.
    const Storage = corridors.every(
      ({ rect }) =>
        Object.is(rect.x | 0, rect.x) &&
        Object.is(rect.y | 0, rect.y) &&
        Object.is((rect.x + rect.width) | 0, rect.x + rect.width) &&
        Object.is((rect.y + rect.height) | 0, rect.y + rect.height),
    )
      ? Int32Array
      : Float64Array;
    const count = corridors.length;
    const storage = new Storage(count * 4);
    const travelStarts = storage.subarray(0, count);
    const travelEnds = storage.subarray(count, count * 2);
    const crossStarts = storage.subarray(count * 2, count * 3);
    const crossEnds = storage.subarray(count * 3);
    const xIndices: number[] = [];
    const yIndices: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const { axis, rect } = corridors[index];
      if (axis === 'x') {
        xIndices.push(index);
        travelStarts[index] = rect.x;
        travelEnds[index] = rect.x + rect.width;
        crossStarts[index] = rect.y;
        crossEnds[index] = rect.y + rect.height;
      } else {
        yIndices.push(index);
        travelStarts[index] = rect.y;
        travelEnds[index] = rect.y + rect.height;
        crossStarts[index] = rect.x;
        crossEnds[index] = rect.x + rect.width;
      }
    }
    this.xIndices = xIndices;
    this.yIndices = yIndices;
    this.travelStarts = travelStarts;
    this.travelEnds = travelEnds;
    this.crossStarts = crossStarts;
    this.crossEnds = crossEnds;
  }

  /** Owned copies for consumers that retain or constrain a span. */
  crossSpan(index: number): AxisSpan {
    return [this.crossStarts[index], this.crossEnds[index]];
  }

  travelSpan(index: number): AxisSpan {
    return [this.travelStarts[index], this.travelEnds[index]];
  }

  crossCenter(index: number): number {
    return (this.crossStarts[index] + this.crossEnds[index]) / 2;
  }

  crossLength(index: number): number {
    return this.crossEnds[index] - this.crossStarts[index];
  }

  crossIncludes(index: number, coordinate: number, epsilon: number): boolean {
    return (
      coordinate >= this.crossStarts[index] - epsilon &&
      coordinate <= this.crossEnds[index] + epsilon
    );
  }

  travelIncludes(index: number, coordinate: number, epsilon: number): boolean {
    return (
      coordinate >= this.travelStarts[index] - epsilon &&
      coordinate <= this.travelEnds[index] + epsilon
    );
  }

  crossContains(outer: number, inner: number, epsilon: number): boolean {
    return (
      this.crossStarts[outer] <= this.crossStarts[inner] + epsilon &&
      this.crossEnds[outer] >= this.crossEnds[inner] - epsilon
    );
  }
}
