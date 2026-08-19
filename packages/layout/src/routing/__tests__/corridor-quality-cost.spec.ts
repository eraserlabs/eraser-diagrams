import {
  compareRoutingQualityCosts,
  ordinaryBendCost,
  RoutingQualityLedger,
  routingQualityCost,
  spacingDeficitCost,
  wallHugCost,
  type RoutingQualityEvent,
  type RoutingQualityEventKind,
} from '../corridor/qualityCost.js';

const event = (
  kind: RoutingQualityEventKind,
  cost: number,
  routeIndexes: readonly number[] = [0],
): RoutingQualityEvent => ({ kind, cost, routeIndexes });

describe('routing corridor progressive quality cost', () => {
  it('charges a strong first bend and cheaper later bends', () => {
    expect([0, 1, 2, 3, 4].map(ordinaryBendCost)).toEqual([0, 48, 72, 96, 120]);
  });

  it('compares invalid, cap, and scalar tiers lexicographically', () => {
    expect(
      compareRoutingQualityCosts(
        { invalid: 0, cap: 1, scalar: 10_000 },
        { invalid: 1, cap: 0, scalar: 0 },
      ),
    ).toBeLessThan(0);
    expect(
      compareRoutingQualityCosts(
        { invalid: 0, cap: 0, scalar: 10_000 },
        { invalid: 0, cap: 1, scalar: 0 },
      ),
    ).toBeLessThan(0);
    expect(
      compareRoutingQualityCosts(
        { invalid: 0, cap: 0, scalar: 10 },
        { invalid: 0, cap: 0, scalar: 20 },
      ),
    ).toBeLessThan(0);
  });

  it('replaces provisional stage sources without duplicating their cost', () => {
    const ledger = new RoutingQualityLedger();
    ledger.replaceSource('spacing:corridor:3', 'spacing', [event('crossing', 30)]);
    ledger.replaceSource('spacing:corridor:3', 'spacing', [event('crossing', 12)]);
    ledger.replaceSource('topology:crossing', 'topology', [event('crossing', 4)]);

    expect(ledger.snapshot().cost).toEqual({ invalid: 0, cap: 0, scalar: 16 });
    ledger.removeStage('spacing');
    expect(ledger.snapshot().cost).toEqual({ invalid: 0, cap: 0, scalar: 4 });
  });

  it('retains complete event attribution in the unfiltered snapshot', () => {
    const ledger = new RoutingQualityLedger();
    ledger.replaceSource('spacing:merge', 'spacing', [event('line-merge', 1, [1, 2])]);
    ledger.replaceSource('spacing:crossing', 'spacing', [event('crossing', 7, [3])]);

    const snapshot = ledger.snapshot();
    expect(snapshot.events.map(({ kind, routeIndexes }) => ({ kind, routeIndexes }))).toEqual([
      { kind: 'line-merge', routeIndexes: [1, 2] },
      { kind: 'crossing', routeIndexes: [3] },
    ]);
    expect(snapshot.cost).toEqual({ invalid: 0, cap: 1, scalar: 7 });
  });

  it('prices gap pressure by squared deficit and shared travel', () => {
    expect(spacingDeficitCost(8, 8, 24)).toBe(0);
    expect(spacingDeficitCost(8, 4, 24)).toBe(25);
    expect(spacingDeficitCost(8, 0, 48)).toBe(200);
    expect(
      routingQualityCost([
        event('spacing-deficit', spacingDeficitCost(8, 4, 24)),
        event('line-merge', 1),
      ]),
    ).toEqual({ invalid: 0, cap: 1, scalar: 25 });
  });

  it('adds unattributed scalar costs without manufacturing events', () => {
    const ledger = new RoutingQualityLedger();
    ledger.replaceSource('emission:geometry', 'emission', [], {
      ordinaryBends: 72,
      pathLength: 120,
      spacingDesire: 0,
    });

    expect(ledger.snapshot()).toMatchObject({
      events: [],
      scalarCosts: { ordinaryBends: 72, pathLength: 120, spacingDesire: 0 },
      cost: { invalid: 0, cap: 0, scalar: 192 },
    });
  });

  it('adds captured spacing desire cost without manufacturing events', () => {
    const ledger = new RoutingQualityLedger();
    ledger.replaceSource('spacing:corridor:4', 'spacing', [], {
      ordinaryBends: 0,
      pathLength: 0,
      spacingDesire: 25,
    });

    expect(ledger.snapshot()).toMatchObject({
      events: [],
      scalarCosts: { ordinaryBends: 0, pathLength: 0, spacingDesire: 25 },
      cost: { invalid: 0, cap: 0, scalar: 0.025 },
    });
  });

  it('prices wall hugs by clearance pressure and shared travel', () => {
    expect(wallHugCost(12, 24, 12)).toBe(0);
    expect(wallHugCost(6, 24, 12)).toBe(12.5);
    expect(wallHugCost(0, 48, 12)).toBe(100);
  });
});
