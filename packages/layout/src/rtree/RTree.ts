/*
 * Portions adapted from RBush 4.0.1 (MIT) and Quickselect 3.0.0 (ISC), both by
 * Vladimir Agafonkin. Substantially modified by Eraser. See
 * ../../THIRD_PARTY_NOTICES.md for provenance and the complete license notices.
 */

import type { LayoutRange, PositionProps } from '../types.js';

export type RTreeBox = LayoutRange;

export interface RTreeNode<T extends PositionProps> extends RTreeBox {
  readonly children: Array<RTreeNode<T> | T>;
  height: number;
  leaf: boolean;
}

type RTreeItemVisitor<T> = (item: T) => void;
type RTreeItemPredicate<T> = (item: T) => boolean;
type RTreeItemCallback<T> = (item: T) => boolean | void;
type RTreeItemEquality<T> = (left: T, right: T) => boolean;
type Comparator<T> = (left: T, right: T) => number;

/**
 * A high-performance two-dimensional spatial index based on an R*-tree.
 *
 * This starts from RBush's insertion, removal, split, and OMT bulk-loading
 * algorithms. In addition to RBush's array-returning `search`, it provides
 * allocation-light visitor and early-exit query APIs for hot layout paths.
 *
 * Items use layout's native `{ x, y, width, height }` model. Queries and
 * internal nodes use `{ minX, minY, maxX, maxY }`, allowing the tree to test
 * leaf items directly without constructing a temporary bounding box.
 */
export class RTree<T extends PositionProps> {
  private readonly maxEntries: number;
  private readonly minEntries: number;
  private data: RTreeNode<T>;

  constructor(maxEntries = 9) {
    // RBush defaults to nine entries and a minimum node fill of 40%.
    this.maxEntries = Math.max(4, maxEntries);
    this.minEntries = Math.max(2, Math.ceil(this.maxEntries * 0.4));
    this.data = createNode([]);
  }

  all(): T[] {
    const result: T[] = [];
    this.visitAll(this.data, (item) => {
      result.push(item);
      return false;
    });
    return result;
  }

  /** Return every item whose bounding box intersects `box`. */
  search(box: RTreeBox): T[] {
    return this.searchBounds(box.minX, box.minY, box.maxX, box.maxY);
  }

  /** Return every item intersecting the supplied scalar bounds. */
  searchBounds(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const result: T[] = [];
    this.visitIntersecting(minX, minY, maxX, maxY, (item) => {
      result.push(item);
      return false;
    });
    return result;
  }

  /** Process intersecting items immediately without allocating a result array. */
  forEachIntersecting(box: RTreeBox, visitor: RTreeItemVisitor<T>): void {
    this.forEachIntersectingBounds(box.minX, box.minY, box.maxX, box.maxY, visitor);
  }

  /** Process items intersecting the supplied scalar bounds. */
  forEachIntersectingBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visitor: RTreeItemVisitor<T>,
  ): void {
    this.visitIntersecting(minX, minY, maxX, maxY, visitor);
  }

  /** Process items intersecting the vertical segment at `x`. */
  forEachAtX(x: number, minY: number, maxY: number, visitor: RTreeItemVisitor<T>): void {
    this.visitIntersecting(x, minY, x, maxY, visitor);
  }

  /** Process items intersecting the horizontal segment at `y`. */
  forEachAtY(y: number, minX: number, maxX: number, visitor: RTreeItemVisitor<T>): void {
    this.visitIntersecting(minX, y, maxX, y, visitor);
  }

  /** Return as soon as an intersecting item satisfies `predicate`. */
  someIntersecting(box: RTreeBox, predicate: RTreeItemPredicate<T>): boolean {
    return this.someIntersectingBounds(box.minX, box.minY, box.maxX, box.maxY, predicate);
  }

  /** Return as soon as an item within the supplied scalar bounds satisfies `predicate`. */
  someIntersectingBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    predicate: RTreeItemPredicate<T>,
  ): boolean {
    return this.visitIntersecting(minX, minY, maxX, maxY, predicate);
  }

  /** Return whether any item intersects `box`. */
  collides(box: RTreeBox): boolean {
    return this.collidesBounds(box.minX, box.minY, box.maxX, box.maxY);
  }

  /** Return whether any item intersects the supplied scalar bounds. */
  collidesBounds(minX: number, minY: number, maxX: number, maxY: number): boolean {
    return this.visitIntersecting(minX, minY, maxX, maxY, () => true);
  }

  /** Bulk-load items using RBush's OMT packing algorithm. */
  load(items: readonly T[]): this {
    if (items.length === 0) {
      return this;
    }

    if (items.length < this.minEntries) {
      for (const item of items) {
        this.insert(item);
      }
      return this;
    }

    let node = this.build(items.slice(), 0, items.length - 1, 0);
    if (this.data.children.length === 0) {
      this.data = node;
    } else if (this.data.height === node.height) {
      this.splitRoot(this.data, node);
    } else {
      if (this.data.height < node.height) {
        const previousRoot = this.data;
        this.data = node;
        node = previousRoot;
      }
      this.insertNode(node, this.data.height - node.height - 1);
    }
    return this;
  }

  insert(item: T): this {
    this.insertItem(item, this.data.height - 1);
    return this;
  }

  clear(): this {
    this.data = createNode([]);
    return this;
  }

  remove(item: T, equals?: RTreeItemEquality<T>): this {
    let node: RTreeNode<T> | undefined = this.data;
    const minX = item.x;
    const minY = item.y;
    const maxX = item.x + item.width;
    const maxY = item.y + item.height;
    const path: RTreeNode<T>[] = [];
    const indexes: number[] = [];
    let childIndex = 0;
    let parent: RTreeNode<T> | undefined;
    let goingUp = false;

    // Depth-first iterative traversal, matching RBush's removal order.
    while (node || path.length > 0) {
      if (!node) {
        node = path.pop();
        parent = path[path.length - 1];
        childIndex = indexes.pop() ?? 0;
        goingUp = true;
      }
      if (!node) {
        break;
      }

      if (node.leaf) {
        const itemIndex = findItem(item, node.children as T[], equals);
        if (itemIndex !== -1) {
          node.children.splice(itemIndex, 1);
          path.push(node);
          this.condense(path);
          return this;
        }
      }

      if (!goingUp && !node.leaf && containsBounds(node, minX, minY, maxX, maxY)) {
        path.push(node);
        indexes.push(childIndex);
        childIndex = 0;
        parent = node;
        node = node.children[0] as RTreeNode<T> | undefined;
      } else if (parent) {
        childIndex += 1;
        node = parent.children[childIndex] as RTreeNode<T> | undefined;
        goingUp = false;
      } else {
        node = undefined;
      }
    }
    return this;
  }

  toJSON(): RTreeNode<T> {
    return this.data;
  }

  fromJSON(data: RTreeNode<T>): this {
    this.data = data;
    return this;
  }

  private visitIntersecting(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    predicate: RTreeItemCallback<T>,
  ): boolean {
    let node: RTreeNode<T> | undefined = this.data;
    if (!intersectsBounds(node, minX, minY, maxX, maxY)) {
      return false;
    }

    const nodesToSearch: RTreeNode<T>[] = [];
    while (node) {
      for (const child of node.children) {
        if (node.leaf) {
          if (!intersectsItemBounds(child as T, minX, minY, maxX, maxY)) {
            continue;
          }
          if (predicate(child as T)) {
            return true;
          }
          continue;
        }
        const childNode = child as RTreeNode<T>;
        if (!intersectsBounds(childNode, minX, minY, maxX, maxY)) {
          continue;
        }
        if (boundsContainBox(minX, minY, maxX, maxY, childNode)) {
          if (this.visitAll(child as RTreeNode<T>, predicate)) {
            return true;
          }
        } else {
          nodesToSearch.push(child as RTreeNode<T>);
        }
      }
      node = nodesToSearch.pop();
    }
    return false;
  }

  private visitAll(node: RTreeNode<T>, predicate: RTreeItemCallback<T>): boolean {
    let current: RTreeNode<T> | undefined = node;
    const nodesToSearch: RTreeNode<T>[] = [];
    while (current) {
      if (current.leaf) {
        for (const child of current.children) {
          if (predicate(child as T)) {
            return true;
          }
        }
      } else {
        nodesToSearch.push(...(current.children as RTreeNode<T>[]));
      }
      current = nodesToSearch.pop();
    }
    return false;
  }

  private build(items: T[], left: number, right: number, requestedHeight: number): RTreeNode<T> {
    const itemCount = right - left + 1;
    let entriesPerNode = this.maxEntries;
    if (itemCount <= entriesPerNode) {
      const leaf = createNode<T>(items.slice(left, right + 1));
      calcBBox(leaf);
      return leaf;
    }

    let height = requestedHeight;
    if (height === 0) {
      height = Math.ceil(Math.log(itemCount) / Math.log(entriesPerNode));
      entriesPerNode = Math.ceil(itemCount / entriesPerNode ** (height - 1));
    }

    const node = createNode<T>([]);
    node.leaf = false;
    node.height = height;

    // Split the items into mostly square tiles, following RBush's OMT loader.
    const tileSize = Math.ceil(itemCount / entriesPerNode);
    const columnSize = tileSize * Math.ceil(Math.sqrt(entriesPerNode));
    multiSelect(items, left, right, columnSize, compareItemMinX);

    for (let columnStart = left; columnStart <= right; columnStart += columnSize) {
      const columnEnd = Math.min(columnStart + columnSize - 1, right);
      multiSelect(items, columnStart, columnEnd, tileSize, compareItemMinY);
      for (let tileStart = columnStart; tileStart <= columnEnd; tileStart += tileSize) {
        const tileEnd = Math.min(tileStart + tileSize - 1, columnEnd);
        node.children.push(this.build(items, tileStart, tileEnd, height - 1));
      }
    }
    calcBBox(node);
    return node;
  }

  private chooseSubtree(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    root: RTreeNode<T>,
    level: number,
    path: RTreeNode<T>[],
  ): RTreeNode<T> {
    let node = root;
    while (true) {
      path.push(node);
      if (node.leaf || path.length - 1 === level) {
        break;
      }

      let minimumArea = Number.POSITIVE_INFINITY;
      let minimumEnlargement = Number.POSITIVE_INFINITY;
      let targetNode: RTreeNode<T> | undefined;
      for (const child of node.children as RTreeNode<T>[]) {
        const area = boxArea(child);
        const enlargement = enlargedArea(minX, minY, maxX, maxY, child) - area;
        if (enlargement < minimumEnlargement) {
          minimumEnlargement = enlargement;
          minimumArea = Math.min(area, minimumArea);
          targetNode = child;
        } else if (enlargement === minimumEnlargement && area < minimumArea) {
          minimumArea = area;
          targetNode = child;
        }
      }
      node = targetNode ?? (node.children[0] as RTreeNode<T>);
    }
    return node;
  }

  private insertItem(item: T, level: number): void {
    this.insertAtLevel(item, item.x, item.y, item.x + item.width, item.y + item.height, level);
  }

  private insertNode(node: RTreeNode<T>, level: number): void {
    this.insertAtLevel(node, node.minX, node.minY, node.maxX, node.maxY, level);
  }

  private insertAtLevel(
    item: T | RTreeNode<T>,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    level: number,
  ): void {
    const insertPath: RTreeNode<T>[] = [];
    const node = this.chooseSubtree(minX, minY, maxX, maxY, this.data, level, insertPath);
    node.children.push(item);
    extendBounds(node, minX, minY, maxX, maxY);

    let currentLevel = level;
    while (currentLevel >= 0) {
      if (insertPath[currentLevel].children.length > this.maxEntries) {
        this.split(insertPath, currentLevel);
        currentLevel -= 1;
      } else {
        break;
      }
    }
    this.adjustParentBoxes(minX, minY, maxX, maxY, insertPath, currentLevel);
  }

  private split(insertPath: RTreeNode<T>[], level: number): void {
    const node = insertPath[level];
    const childCount = node.children.length;
    this.chooseSplitAxis(node, this.minEntries, childCount);
    const splitIndex = this.chooseSplitIndex(node, this.minEntries, childCount);
    const newNode = createNode<T>(node.children.splice(splitIndex));
    newNode.height = node.height;
    newNode.leaf = node.leaf;
    calcBBox(node);
    calcBBox(newNode);

    if (level > 0) {
      insertPath[level - 1].children.push(newNode);
    } else {
      this.splitRoot(node, newNode);
    }
  }

  private splitRoot(node: RTreeNode<T>, newNode: RTreeNode<T>): void {
    this.data = createNode([node, newNode]);
    this.data.height = node.height + 1;
    this.data.leaf = false;
    calcBBox(this.data);
  }

  private chooseSplitIndex(node: RTreeNode<T>, minimum: number, maximum: number): number {
    let bestIndex: number | undefined;
    let minimumOverlap = Number.POSITIVE_INFINITY;
    let minimumArea = Number.POSITIVE_INFINITY;

    for (let index = minimum; index <= maximum - minimum; index += 1) {
      const firstBox = distributedBox(node, 0, index);
      const secondBox = distributedBox(node, index, maximum);
      const overlap = intersectionArea(firstBox, secondBox);
      const area = boxArea(firstBox) + boxArea(secondBox);
      if (overlap < minimumOverlap) {
        minimumOverlap = overlap;
        bestIndex = index;
        minimumArea = Math.min(area, minimumArea);
      } else if (overlap === minimumOverlap && area < minimumArea) {
        minimumArea = area;
        bestIndex = index;
      }
    }
    return bestIndex ?? maximum - minimum;
  }

  private chooseSplitAxis(node: RTreeNode<T>, minimum: number, maximum: number): void {
    const compareMinX: Comparator<RTreeNode<T> | T> = node.leaf
      ? (left, right) => compareItemMinX(left as T, right as T)
      : (left, right) => compareNodeMinX(left as RTreeNode<T>, right as RTreeNode<T>);
    const compareMinY: Comparator<RTreeNode<T> | T> = node.leaf
      ? (left, right) => compareItemMinY(left as T, right as T)
      : (left, right) => compareNodeMinY(left as RTreeNode<T>, right as RTreeNode<T>);
    const xMargin = this.allDistributedMargin(node, minimum, maximum, compareMinX);
    const yMargin = this.allDistributedMargin(node, minimum, maximum, compareMinY);
    if (xMargin < yMargin) {
      node.children.sort(compareMinX);
    }
  }

  private allDistributedMargin(
    node: RTreeNode<T>,
    minimum: number,
    maximum: number,
    compare: Comparator<RTreeNode<T> | T>,
  ): number {
    node.children.sort(compare);
    const leftBox = distributedBox(node, 0, minimum);
    const rightBox = distributedBox(node, maximum - minimum, maximum);
    let margin = boxMargin(leftBox) + boxMargin(rightBox);

    for (let index = minimum; index < maximum - minimum; index += 1) {
      const child = node.children[index];
      if (node.leaf) {
        extendItem(leftBox, child as T);
      } else {
        extendBox(leftBox, child as RTreeNode<T>);
      }
      margin += boxMargin(leftBox);
    }
    for (let index = maximum - minimum - 1; index >= minimum; index -= 1) {
      const child = node.children[index];
      if (node.leaf) {
        extendItem(rightBox, child as T);
      } else {
        extendBox(rightBox, child as RTreeNode<T>);
      }
      margin += boxMargin(rightBox);
    }
    return margin;
  }

  private adjustParentBoxes(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    path: RTreeNode<T>[],
    level: number,
  ): void {
    for (let index = level; index >= 0; index -= 1) {
      extendBounds(path[index], minX, minY, maxX, maxY);
    }
  }

  private condense(path: RTreeNode<T>[]): void {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index];
      if (node.children.length === 0) {
        if (index > 0) {
          const siblings = path[index - 1].children;
          siblings.splice(siblings.indexOf(node), 1);
        } else {
          this.clear();
        }
      } else {
        calcBBox(node);
      }
    }
  }
}

function findItem<T extends PositionProps>(
  item: T,
  items: readonly T[],
  equals?: RTreeItemEquality<T>,
): number {
  if (!equals) {
    return items.indexOf(item);
  }
  return items.findIndex((candidate) => equals(item, candidate));
}

function calcBBox<T extends PositionProps>(node: RTreeNode<T>): void {
  distributedBox(node, 0, node.children.length, node);
}

function distributedBox<T extends PositionProps>(
  node: RTreeNode<T>,
  start: number,
  end: number,
  destination: RTreeNode<T> = createNode([]),
): RTreeNode<T> {
  destination.minX = Number.POSITIVE_INFINITY;
  destination.minY = Number.POSITIVE_INFINITY;
  destination.maxX = Number.NEGATIVE_INFINITY;
  destination.maxY = Number.NEGATIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    const child = node.children[index];
    if (node.leaf) {
      extendItem(destination, child as T);
    } else {
      extendBox(destination, child as RTreeNode<T>);
    }
  }
  return destination;
}

function extendItem(target: RTreeBox, item: PositionProps): void {
  extendBounds(target, item.x, item.y, item.x + item.width, item.y + item.height);
}

function extendBox(target: RTreeBox, addition: RTreeBox): void {
  extendBounds(target, addition.minX, addition.minY, addition.maxX, addition.maxY);
}

function extendBounds(
  target: RTreeBox,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  target.minX = Math.min(target.minX, minX);
  target.minY = Math.min(target.minY, minY);
  target.maxX = Math.max(target.maxX, maxX);
  target.maxY = Math.max(target.maxY, maxY);
}

function compareItemMinX(left: PositionProps, right: PositionProps): number {
  return left.x - right.x;
}

function compareItemMinY(left: PositionProps, right: PositionProps): number {
  return left.y - right.y;
}

function compareNodeMinX(left: RTreeBox, right: RTreeBox): number {
  return left.minX - right.minX;
}

function compareNodeMinY(left: RTreeBox, right: RTreeBox): number {
  return left.minY - right.minY;
}

function boxArea(box: RTreeBox): number {
  return (box.maxX - box.minX) * (box.maxY - box.minY);
}

function boxMargin(box: RTreeBox): number {
  return box.maxX - box.minX + (box.maxY - box.minY);
}

function enlargedArea(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  second: RTreeBox,
): number {
  return (
    (Math.max(second.maxX, maxX) - Math.min(second.minX, minX)) *
    (Math.max(second.maxY, maxY) - Math.min(second.minY, minY))
  );
}

function intersectionArea(first: RTreeBox, second: RTreeBox): number {
  const minX = Math.max(first.minX, second.minX);
  const minY = Math.max(first.minY, second.minY);
  const maxX = Math.min(first.maxX, second.maxX);
  const maxY = Math.min(first.maxY, second.maxY);
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

function boundsContainBox(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  inner: RTreeBox,
): boolean {
  return minX <= inner.minX && minY <= inner.minY && inner.maxX <= maxX && inner.maxY <= maxY;
}

function containsBounds(
  outer: RTreeBox,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return outer.minX <= minX && outer.minY <= minY && maxX <= outer.maxX && maxY <= outer.maxY;
}

function intersectsBounds(
  box: RTreeBox,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return box.minX <= maxX && box.minY <= maxY && box.maxX >= minX && box.maxY >= minY;
}

function intersectsItemBounds(
  item: PositionProps,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return (
    item.x <= maxX && item.y <= maxY && item.x + item.width >= minX && item.y + item.height >= minY
  );
}

function createNode<T extends PositionProps>(children: Array<RTreeNode<T> | T>): RTreeNode<T> {
  return {
    children,
    height: 1,
    leaf: true,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

/** Floyd-Rivest quickselect, derived from Quickselect 2.0.0. */
function quickselect<T>(
  items: T[],
  selection: number,
  left: number,
  right: number,
  compare: Comparator<T>,
): void {
  let lower = left;
  let upper = right;
  while (upper > lower) {
    if (upper - lower > 600) {
      const itemCount = upper - lower + 1;
      const selectionOffset = selection - lower + 1;
      const logarithm = Math.log(itemCount);
      const sampleSize = 0.5 * Math.exp((2 * logarithm) / 3);
      const sampleDelta =
        0.5 *
        Math.sqrt((logarithm * sampleSize * (itemCount - sampleSize)) / itemCount) *
        (selectionOffset - itemCount / 2 < 0 ? -1 : 1);
      const newLeft = Math.max(
        lower,
        Math.floor(selection - (selectionOffset * sampleSize) / itemCount + sampleDelta),
      );
      const newRight = Math.min(
        upper,
        Math.floor(
          selection + ((itemCount - selectionOffset) * sampleSize) / itemCount + sampleDelta,
        ),
      );
      quickselect(items, selection, newLeft, newRight, compare);
    }

    const selected = items[selection];
    let leftIndex = lower;
    let rightIndex = upper;
    swap(items, lower, selection);
    if (compare(items[upper], selected) > 0) {
      swap(items, lower, upper);
    }

    while (leftIndex < rightIndex) {
      swap(items, leftIndex, rightIndex);
      leftIndex += 1;
      rightIndex -= 1;
      while (compare(items[leftIndex], selected) < 0) {
        leftIndex += 1;
      }
      while (compare(items[rightIndex], selected) > 0) {
        rightIndex -= 1;
      }
    }

    if (compare(items[lower], selected) === 0) {
      swap(items, lower, rightIndex);
    } else {
      rightIndex += 1;
      swap(items, rightIndex, upper);
    }
    if (rightIndex <= selection) {
      lower = rightIndex + 1;
    }
    if (selection <= rightIndex) {
      upper = rightIndex - 1;
    }
  }
}

function swap<T>(items: T[], left: number, right: number): void {
  const item = items[left];
  items[left] = items[right];
  items[right] = item;
}

function multiSelect<T>(
  items: T[],
  left: number,
  right: number,
  groupSize: number,
  compare: Comparator<T>,
): void {
  const stack = [left, right];
  while (stack.length > 0) {
    const currentRight = stack.pop();
    const currentLeft = stack.pop();
    if (currentLeft === undefined || currentRight === undefined) {
      throw new Error('RTree bulk-load selection stack is unbalanced');
    }
    if (currentRight - currentLeft <= groupSize) {
      continue;
    }
    const middle =
      currentLeft + Math.ceil((currentRight - currentLeft) / groupSize / 2) * groupSize;
    quickselect(items, middle, currentLeft, currentRight, compare);
    stack.push(currentLeft, middle, middle, currentRight);
  }
}
