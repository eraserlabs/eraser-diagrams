/** Union-find backed by one reusable typed array. */
export interface UnionFind {
  /** Root of the set containing index, with path compression. */
  readonly find: (index: number) => number;
  /** Merge merged's set into survivor's; survivor's root remains canonical. */
  readonly unionInto: (survivor: number, merged: number) => number;
  /** Merge both sets with their minimum-index root as the canonical root. */
  readonly unionMin: (left: number, right: number) => number;
  /** Reinitialize for a new problem, retaining allocated capacity. */
  readonly reset: (size: number) => void;
}

export function createUnionFind(): UnionFind {
  let parent = new Int32Array(0);

  const reset = (size: number): void => {
    if (size > parent.length) {
      parent = new Int32Array(Math.max(size, parent.length * 2));
    }
    for (let index = 0; index < size; index += 1) {
      parent[index] = index;
    }
  };

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };

  const unionInto = (survivor: number, merged: number): number => {
    const survivorRoot = find(survivor);
    const mergedRoot = find(merged);
    if (survivorRoot !== mergedRoot) {
      parent[mergedRoot] = survivorRoot;
    }
    return survivorRoot;
  };

  const unionMin = (left: number, right: number): number => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    const minimumRoot = Math.min(leftRoot, rightRoot);
    if (leftRoot !== rightRoot) {
      parent[Math.max(leftRoot, rightRoot)] = minimumRoot;
    }
    return minimumRoot;
  };

  return { find, unionInto, unionMin, reset };
}
