/** First index whose entry is >= `value` in an ascending array. */
function lowerBound(values: readonly number[], value: number, from = 0): number {
  let low = from;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** First index whose entry is > `value` in an ascending array. */
export function upperBound(values: readonly number[], value: number, from = 0): number {
  let low = from;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// Keep typed-array bounds monomorphic so hot callers do not pay for polymorphic access.

/** First index whose entry is >= `value` in an ascending table. */
export function lowerBoundInt32(coords: Int32Array, value: number): number {
  let low = 0;
  let high = coords.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (coords[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** First index whose entry is > `value` in an ascending table. */
export function upperBoundInt32(coords: Int32Array, value: number): number {
  let low = 0;
  let high = coords.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (coords[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Insert `item` at `index`, shifting the tail right. Avoids `.splice`, which allocates a
 * result array even when nothing is removed. Callers own the search: the sorted inserts
 * here differ in bound and in whether ties are allowed, so only this tail is shared.
 */
function insertAt<T>(array: T[], index: number, item: T): void {
  array.push(item);
  array.copyWithin(index + 1, index);
  array[index] = item;
}

/**
 * Insert into a comparator-sorted array after any elements comparing equal.
 */
export function insertIntoSortedBy<T>(
  sorted: T[],
  item: T,
  compare: (left: T, right: T) => number,
): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compare(sorted[mid], item) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  insertAt(sorted, low, item);
}

/**
 * Add a number, if not already in the sorted array.
 * @returns the index of the added number, or -1 if the number is already in the array.
 */
export function addUniqueNumber(sorted: number[], num: number, initialIdx: number): number {
  const idx = lowerBound(sorted, num, initialIdx);
  if (idx < sorted.length && sorted[idx] === num) {
    // No duplicates
    return -1;
  }
  insertAt(sorted, idx, num);
  return idx;
}

/**
 * Ascending in-place sort + dedupe. The explicit comparator matters for plain arrays
 * (whose default sort is lexicographic) and is a harmless restatement for Int32Array,
 * whose default sort is already numeric despite looking like the Array footgun.
 */
export function sortedUnique(values: number[] | Int32Array): number[] {
  values.sort((left, right) => left - right);
  const kept: number[] = [];
  for (const value of values) {
    if (kept.length === 0 || value !== kept[kept.length - 1]) {
      kept.push(value);
    }
  }
  return kept;
}
