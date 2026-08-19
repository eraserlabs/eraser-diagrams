import { RTree, type RTreeBox } from '../RTree.js';

interface TestItem {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function testItems(count: number, offset = 0): TestItem[] {
  return Array.from({ length: count }, (_, localIndex) => {
    const id = offset + localIndex;
    const x = ((id * 37) % 211) - 100;
    const y = ((id * 61) % 197) - 90;
    return {
      id,
      x,
      y,
      width: id % 9 === 0 ? 0 : (id * 17) % 23,
      height: id % 11 === 0 ? 0 : (id * 29) % 19,
    };
  });
}

function itemRange(item: TestItem): RTreeBox {
  return {
    minX: item.x,
    minY: item.y,
    maxX: item.x + item.width,
    maxY: item.y + item.height,
  };
}

function intersects(range: RTreeBox, item: TestItem): boolean {
  return (
    item.x <= range.maxX &&
    item.y <= range.maxY &&
    item.x + item.width >= range.minX &&
    item.y + item.height >= range.minY
  );
}

function sortedIds(items: readonly TestItem[]): number[] {
  return items.map((item) => item.id).sort((left, right) => left - right);
}

describe('RTree', () => {
  it('bulk-loads and searches native layout items, including zero-area items', () => {
    const items = testItems(250);
    const tree = new RTree<TestItem>().load(items);

    expect(sortedIds(tree.all())).toEqual(sortedIds(items));
    for (const queryItem of testItems(60, 1_000)) {
      const query = itemRange(queryItem);
      const expected = items.filter((item) => intersects(query, item));
      expect(sortedIds(tree.search(query))).toEqual(sortedIds(expected));
      expect(tree.collides(query)).toBe(expected.length > 0);
    }
  });

  it('visits matches without changing search order or constructing a caller-visible array', () => {
    const tree = new RTree<TestItem>().load(testItems(100));
    const query = { minX: -40, minY: -30, maxX: 60, maxY: 70 };
    const visited: TestItem[] = [];

    tree.forEachIntersecting(query, (item) => {
      visited.push(item);
    });

    expect(visited).toEqual(tree.search(query));
  });

  it('supports scalar-bound and axis-segment queries without query objects', () => {
    const items = testItems(100);
    const tree = new RTree<TestItem>().load(items);
    const bounds = [-40, -30, 60, 70] as const;
    const range = { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] };
    const visited: TestItem[] = [];
    const atX: TestItem[] = [];
    const atY: TestItem[] = [];

    tree.forEachIntersectingBounds(...bounds, (item) => {
      visited.push(item);
    });
    tree.forEachAtX(10, -30, 70, (item) => {
      atX.push(item);
    });
    tree.forEachAtY(20, -40, 60, (item) => {
      atY.push(item);
    });

    expect(visited).toEqual(tree.search(range));
    expect(tree.searchBounds(...bounds)).toEqual(tree.search(range));
    expect(tree.collidesBounds(...bounds)).toBe(tree.collides(range));
    expect(tree.someIntersectingBounds(...bounds, (item) => item.id === visited[0]?.id)).toBe(
      visited.length > 0,
    );
    expect(sortedIds(atX)).toEqual(
      sortedIds(
        items.filter(
          (item) =>
            item.x <= 10 &&
            item.x + item.width >= 10 &&
            item.y <= 70 &&
            item.y + item.height >= -30,
        ),
      ),
    );
    expect(sortedIds(atY)).toEqual(
      sortedIds(
        items.filter(
          (item) =>
            item.x <= 60 &&
            item.x + item.width >= -40 &&
            item.y <= 20 &&
            item.y + item.height >= 20,
        ),
      ),
    );
  });

  it('terminates a predicate query at the first accepted item', () => {
    const tree = new RTree<TestItem>().load(testItems(100));
    const everything = {
      minX: Number.NEGATIVE_INFINITY,
      minY: Number.NEGATIVE_INFINITY,
      maxX: Number.POSITIVE_INFINITY,
      maxY: Number.POSITIVE_INFINITY,
    };
    let acceptedVisits = 0;
    let rejectedVisits = 0;

    expect(
      tree.someIntersecting(everything, () => {
        acceptedVisits += 1;
        return true;
      }),
    ).toBe(true);
    expect(
      tree.someIntersecting(everything, () => {
        rejectedVisits += 1;
        return false;
      }),
    ).toBe(false);
    expect(acceptedVisits).toBe(1);
    expect(rejectedVisits).toBe(100);
  });

  it('supports incremental insertion, removal, equality removal, and clearing', () => {
    const items = testItems(80);
    const tree = new RTree<TestItem>(4);
    for (const item of items) {
      tree.insert(item);
    }

    tree.remove(items[10]);
    tree.remove({ ...items[20] }, (left, right) => left.id === right.id);
    const retained = items.filter((item) => item.id !== items[10].id && item.id !== items[20].id);
    expect(sortedIds(tree.all())).toEqual(sortedIds(retained));

    for (const queryItem of testItems(30, 2_000)) {
      const query = itemRange(queryItem);
      expect(sortedIds(tree.search(query))).toEqual(
        sortedIds(retained.filter((item) => intersects(query, item))),
      );
    }

    tree.clear();
    expect(tree.all()).toEqual([]);
    expect(tree.search(itemRange(items[0]))).toEqual([]);
  });

  it('merges later bulk loads into trees of equal and unequal heights', () => {
    const first = testItems(90);
    const second = testItems(90, 1_000);
    const third = testItems(5, 2_000);
    const tree = new RTree<TestItem>(4).load(first).load(second).load(third);
    const items = [...first, ...second, ...third];

    expect(sortedIds(tree.all())).toEqual(sortedIds(items));
    for (const queryItem of testItems(30, 3_000)) {
      const query = itemRange(queryItem);
      expect(sortedIds(tree.search(query))).toEqual(
        sortedIds(items.filter((item) => intersects(query, item))),
      );
    }
  });

  it('round-trips its RBush-compatible JSON representation', () => {
    const items = testItems(100);
    const source = new RTree<TestItem>().load(items);
    const serialized = JSON.stringify(source.toJSON());
    const restored = new RTree<TestItem>().fromJSON(
      JSON.parse(serialized) as ReturnType<typeof source.toJSON>,
    );

    expect(sortedIds(restored.all())).toEqual(sortedIds(items));
    expect(sortedIds(restored.search({ minX: -20, minY: -20, maxX: 20, maxY: 20 }))).toEqual(
      sortedIds(
        items.filter((item) => intersects({ minX: -20, minY: -20, maxX: 20, maxY: 20 }, item)),
      ),
    );
  });

  it('indexes original position-and-size item references directly', () => {
    interface PositionedItem {
      readonly id: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }

    const items: PositionedItem[] = [
      { id: 1, x: 0, y: 0, width: 10, height: 10 },
      { id: 2, x: 20, y: 20, width: 5, height: 5 },
      { id: 3, x: 5, y: 30, width: 0, height: 10 },
    ];
    const tree = new RTree<PositionedItem>().load(items);

    const matches = tree.search({ minX: 9, minY: 9, maxX: 21, maxY: 21 });
    expect(matches.map((item) => item.id)).toEqual([1, 2]);
    expect(matches[0]).toBe(items[0]);
    expect(matches[1]).toBe(items[1]);
  });
});
