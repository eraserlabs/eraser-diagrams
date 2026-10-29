import type { LayoutEntity } from '../../types.js';
import { LayoutManager } from '../../LayoutManager.js';
import type {
  Corridor,
  PortalRef,
  RouteSearchRequest,
  TerminalAttachment,
} from '../corridor/contract.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { searchRoute } from '../corridor/topology.js';
import { guideFamilyRoutes } from '../corridor/familyGuidance.js';
import { adoptRoute } from '../corridor/adoptRoutes.js';
import { createRepairSearch } from '../corridor/repairSearch.js';
import { realizeRoutes } from '../corridor/realize.js';
import {
  PORTAL_SEARCH_TIER_ESCAPE,
  PORTAL_SEARCH_TIER_PREFERRED,
  type CorridorWorld,
} from '../corridor/world.js';
import { leaf, manualCorridorWorld } from '../routingTestUtils.js';

const MANUAL_BOUNDS = { x: -20, y: -20, width: 80, height: 140 };

function buildWorld(
  entities: readonly LayoutEntity[],
  requests: readonly RouteSearchRequest[],
): CorridorWorld {
  return buildCorridorWorld(
    new LayoutManager({ entities: [...entities], connections: [] }),
    requests,
  );
}

function request(
  fromEntityIndex: number,
  toEntityIndex: number,
  fromFace: 'up' | 'right' | 'down' | 'left',
  toFace: 'up' | 'right' | 'down' | 'left',
  authoredTracks?: { readonly from?: number; readonly to?: number },
): RouteSearchRequest {
  return {
    requestIndex: 0,
    from: {
      entityIndex: fromEntityIndex,
      face: fromFace,
      ...(authoredTracks?.from !== undefined ? { authoredTrack: authoredTracks.from } : {}),
    },
    to: {
      entityIndex: toEntityIndex,
      face: toFace,
      ...(authoredTracks?.to !== undefined ? { authoredTrack: authoredTracks.to } : {}),
    },
  };
}

function search(entities: readonly LayoutEntity[], routeRequest: RouteSearchRequest) {
  return searchRoute(buildWorld(entities, [routeRequest]), routeRequest);
}

describe('routing corridor feasible-interval topology', () => {
  it.each([false, true])(
    'guides local same-face turns from frozen seeds (reversed=%s)',
    (reversed) => {
      const entities = [
        leaf('shared', 0, 0, 10, 20),
        leaf('leader', 40, 100, 20, 20),
        leaf('follower', 20, 100, 40, 20),
        leaf('straight', 100, 0, 20, 20),
      ];
      const corridors: Corridor[] = [
        { index: 0, axis: 'x', rect: { x: 10, y: 0, width: 90, height: 20 } },
        { index: 1, axis: 'y', rect: { x: 20, y: 0, width: 20, height: 100 } },
        { index: 2, axis: 'y', rect: { x: 40, y: 0, width: 20, height: 100 } },
      ];
      const portals: PortalRef[] = [
        {
          index: 0,
          kind: 'turn',
          xCorridorIndex: 0,
          yCorridorIndex: 1,
          rect: { x: 20, y: 0, width: 20, height: 20 },
        },
        {
          index: 1,
          kind: 'turn',
          xCorridorIndex: 0,
          yCorridorIndex: 2,
          rect: { x: 40, y: 0, width: 20, height: 20 },
        },
      ];
      const attachments: TerminalAttachment[] = [
        { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
        { index: 1, entityIndex: 1, face: 'up', corridorIndex: 2, faceSpan: [40, 60] },
        { index: 2, entityIndex: 2, face: 'up', corridorIndex: 1, faceSpan: [20, 40] },
        { index: 3, entityIndex: 2, face: 'up', corridorIndex: 2, faceSpan: [40, 60] },
        { index: 4, entityIndex: 3, face: 'left', corridorIndex: 0, faceSpan: [0, 20] },
      ];
      const requests = [
        request(0, 1, 'right', 'up'),
        request(0, 2, 'right', 'up'),
        request(0, 3, 'right', 'left'),
      ].map((routeRequest, requestIndex) => ({
        ...routeRequest,
        requestIndex,
        ...(reversed ? { from: routeRequest.to, to: routeRequest.from } : {}),
      }));
      const world = manualCorridorWorld(entities, corridors, portals, attachments, {
        x: -20,
        y: -20,
        width: 160,
        height: 160,
      });
      const seeds = requests.map((routeRequest) => searchRoute(world, routeRequest));
      const leaderPoints: [number, number][] = [
        [10, 10],
        [50, 10],
        [50, 100],
      ];
      const adoptedLeader = adoptRoute(
        world,
        requests[0],
        reversed ? leaderPoints.reverse() : leaderPoints,
        { pinTracks: true },
      );
      expect(adoptedLeader).toBeDefined();
      expect(
        adoptedLeader!.visits.every((visit) => visit.feasibleTrack[0] === visit.feasibleTrack[1]),
      ).toBe(true);
      // A real adoption has point-valued track bands and no search cost.
      seeds[0] = { ...seeds[0], route: adoptedLeader!, cost: undefined };
      const options = { penalty: 1000, localRadius: 200 };
      const guided = guideFamilyRoutes(world, requests, seeds, new Set([0]), options);
      expect(guided.traces.find((trace) => trace.requestIndex === 1)).toMatchObject({
        leaderRequestIndexes: [0],
        seedSurcharge: 1000,
        searched: true,
        accepted: true,
        candidateSurcharge: 0,
      });
      expect(guided.searchResults[0]).toBe(seeds[0]);
      expect(guided.searchResults[2]).toBe(seeds[2]);
      const reordered = guideFamilyRoutes(
        world,
        [...requests].reverse(),
        [...seeds].reverse(),
        new Set([0]),
        options,
      );
      expect(reordered.searchResults.slice().reverse()).toEqual(guided.searchResults);
      expect(
        guideFamilyRoutes(world, requests, seeds, new Set([0, 1]), options).searchResults,
      ).toEqual(seeds);
      expect(
        guideFamilyRoutes(world, requests, seeds, new Set([0]), { ...options, localRadius: 5 })
          .searchResults,
      ).toEqual(seeds);
      expect(
        guideFamilyRoutes(world, requests, seeds, new Set([0]), { ...options, penalty: 0 })
          .searchResults,
      ).toEqual(seeds);
    },
  );

  it('prices directed actual turns without affecting authored tracks', () => {
    const from = request(0, 1, 'right', 'up', { from: 20, to: 220 });
    const world = buildWorld([leaf('from', 0, 0, 40, 40), leaf('to', 200, 200, 40, 40)], [from]);
    const baseline = searchRoute(world, from);
    const prices = new Map(world.indexer.portals.map((portal) => [2 * portal.index, 7]));
    const priced = searchRoute(world, from, { turnPortalPenalties: prices });
    expect(priced.route.visits).toEqual(baseline.route.visits);
    expect(priced.cost).toEqual({
      ...baseline.cost,
      turnPortalPenalty: 7,
      total: baseline.cost!.total + 7,
    });
    const reversed = { ...from, from: from.to, to: from.from };
    expect(searchRoute(world, reversed, { turnPortalPenalties: prices })).toEqual(
      searchRoute(world, reversed),
    );
  });

  it('reuses exact repair searches without sharing realized geometry or changed requests', () => {
    const original = request(0, 1, 'right', 'left');
    const pinned = request(0, 1, 'right', 'left', { from: 12, to: 12 });
    const world = buildWorld(
      [leaf('from', 0, 0, 40, 40), leaf('to', 200, 0, 40, 40)],
      [original, pinned],
    );
    const cache = createRepairSearch(world);
    const first = cache.search(original, { hiddenPortalIndexes: new Set() });
    const realized = realizeRoutes(world, [first.route]);
    expect(realized.routes[0].hasRealization()).toBe(true);
    expect(first.route.hasRealization()).toBe(false);
    expect(cache.search(original, { hiddenPortalIndexes: new Set() })).toBe(first);
    expect(
      cache.search(
        { ...original, from: { ...original.from }, to: { ...original.to } },
        { hiddenPortalIndexes: new Set() },
      ),
    ).toBe(first);
    const changed = cache.search(pinned, { hiddenPortalIndexes: new Set() });
    expect(changed).not.toBe(first);
    expect(changed).toEqual(searchRoute(world, pinned, { hiddenPortalIndexes: new Set() }));
    expect(cache.metrics).toEqual({ searches: 2, cacheHits: 2 });
    expect(createRepairSearch(world).search(original)).not.toBe(first);
  });

  it('keeps repair restrictions and prices distinct and reuses failed searches', () => {
    const routeRequest = request(0, 1, 'right', 'left');
    const world = buildWorld(
      [leaf('from', 0, 0, 40, 40), leaf('to', 200, 0, 40, 40)],
      [routeRequest],
    );
    const cache = createRepairSearch(world);
    const options: Parameters<typeof searchRoute>[2][] = [
      {},
      { hiddenPortalIndexes: new Set([0]) },
      { hiddenAttachmentIndexes: new Set([0]) },
      { requiredCorridorIndex: 0 },
      { corridorEntryPenalties: new Map([[0, 1]]) },
      { corridorEntryPenalties: new Map([[0, 2]]) },
      { preferCenteredTerminalAttachments: false },
      { hiddenAttachmentIndexes: new Set(world.indexer.attachments.map(({ index }) => index)) },
    ];
    const results = options.map((option) => {
      const result = cache.search(routeRequest, option);
      expect(result).toEqual(searchRoute(world, routeRequest, option));
      expect(cache.search(routeRequest, option)).toBe(result);
      return result;
    });
    expect(new Set(results).size).toBe(options.length);
    expect(results.at(-1)?.fallback).toBe(true);
    expect(cache.metrics).toEqual({ searches: options.length, cacheHits: options.length });
  });

  it('uses one visit and no bends for a direct face-to-face route', () => {
    const routeRequest = request(0, 1, 'right', 'left');
    const result = search([leaf('from', 0, 0, 40, 40), leaf('to', 200, 0, 40, 40)], routeRequest);

    expect(result.fallback).toBe(false);
    expect(result.route.visits).toHaveLength(1);
    expect(result.cost).toEqual({
      distance: 160,
      bendCount: 0,
      narrow: 0,
      terminal: 0,
      corridorPenalty: 1,
      total: 161,
    });
  });

  it('prefers a terminal slice containing face center without hiding alternatives', () => {
    const entities = [leaf('from', 0, 0, 10, 100), leaf('to', 100, 0, 10, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 10, y: 0, width: 90, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 10, y: 40, width: 90, height: 20 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 0, face: 'right', corridorIndex: 1, faceSpan: [40, 60] },
      { index: 2, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 3, entityIndex: 1, face: 'left', corridorIndex: 1, faceSpan: [40, 60] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');

    const result = searchRoute(
      manualCorridorWorld(entities, corridors, [], attachments, MANUAL_BOUNDS),
      routeRequest,
    );

    expect(result.fallback).toBe(false);
    expect(result.route.visits.map((visit) => visit.corridorIndex)).toEqual([1]);
    expect(result.cost?.terminal).toBe(0);
  });

  it('can omit an off-center terminal attachment for an isolated repair search', () => {
    const entities = [leaf('from', 0, 0, 10, 100), leaf('to', 100, 0, 10, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 10, y: 0, width: 90, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 10, y: 40, width: 90, height: 20 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 0, face: 'right', corridorIndex: 1, faceSpan: [40, 60] },
      { index: 2, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 3, entityIndex: 1, face: 'left', corridorIndex: 1, faceSpan: [40, 60] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const world = manualCorridorWorld(entities, corridors, [], attachments, MANUAL_BOUNDS);

    const result = searchRoute(world, routeRequest, {
      hiddenAttachmentIndexes: new Set([1, 3]),
    });

    expect(result.fallback).toBe(false);
    expect(result.route.visits.map((visit) => visit.corridorIndex)).toEqual([0]);
  });

  it('prices one-bend and obstacle-detour routes as real topology', () => {
    const oneBend = request(0, 1, 'right', 'up');
    const oneBendResult = search(
      [leaf('from', 0, 0, 40, 40), leaf('to', 200, 100, 40, 40)],
      oneBend,
    );
    expect(oneBendResult.fallback).toBe(false);
    // Continuation portals may split the approach run; the priced topology is still one turn.
    expect(oneBendResult.route.visits.length).toBeGreaterThan(1);
    expect(oneBendResult.cost?.bendCount).toBe(1);

    const twoBend = request(0, 2, 'right', 'left');
    const twoBendResult = search(
      [leaf('from', 0, 0, 40, 40), leaf('blocker', 100, -10, 40, 60), leaf('to', 200, 0, 40, 40)],
      twoBend,
    );
    expect(twoBendResult.fallback).toBe(false);
    expect(twoBendResult.route.visits).toHaveLength(5);
    expect(twoBendResult.cost?.bendCount).toBe(4);
  });

  it('continues a far-off aligned route without taking a cheap bounce', () => {
    const routeRequest = request(0, 1, 'right', 'left');
    const world = buildWorld(
      [
        leaf('from', 0, 0, 40, 40),
        leaf('to', 600, 0, 40, 40),
        leaf('above', 200, -100, 60, 80),
        leaf('below', 400, 60, 60, 80),
      ],
      [routeRequest],
    );
    const result = searchRoute(world, routeRequest);

    expect(result.fallback).toBe(false);
    // The straight run crosses several continuation portals but must stay bend-free.
    expect(result.route.visits.length).toBeGreaterThan(1);
    expect(result.cost).toEqual({
      distance: 560,
      bendCount: 0,
      narrow: 0,
      terminal: 0,
      total: 560,
    });
    const prices = new Map(
      world.indexer.portals.flatMap(
        (portal) =>
          [
            [2 * portal.index, 100],
            [2 * portal.index + 1, 100],
          ] as [number, number][],
      ),
    );
    expect(searchRoute(world, routeRequest, { turnPortalPenalties: prices })).toEqual(result);
  });

  it('requires a real detour when authored tracks cannot meet in one corridor', () => {
    const routeRequest = request(0, 1, 'right', 'left', { from: 25, to: 75 });
    const result = search([leaf('from', 0, 0, 40, 100), leaf('to', 200, 0, 40, 100)], routeRequest);

    expect(result.fallback).toBe(false);
    expect(result.metrics.passCount).toBe(1);
    expect(result.route.visits).toHaveLength(3);
    expect(result.cost?.bendCount).toBe(2);
    expect(result.route.visits[0].feasibleTrack).toEqual([25, 25]);
    expect(result.route.visits[2].feasibleTrack).toEqual([75, 75]);
  });

  it('rejects a same-corridor destination outside the surviving entry span', () => {
    const entities = [leaf('from', -10, 0, 10, 10), leaf('to', 100, 20, 10, 10)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 100, height: 30 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 10] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [20, 30] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const result = searchRoute(
      manualCorridorWorld(entities, corridors, [], attachments, MANUAL_BOUNDS),
      routeRequest,
    );

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('unreachable');
  });

  it('keeps disjoint feasible intervals as nondominated labels in one corridor', () => {
    // This hand-built index isolates label dominance from the already-tested world decomposition.
    const entities = [leaf('from', -10, 0, 10, 100), leaf('to', 30, 0, 10, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 25, height: 100 } },
      { index: 1, axis: 'y', rect: { x: 5, y: 0, width: 20, height: 20 } },
      { index: 2, axis: 'y', rect: { x: 5, y: 80, width: 20, height: 20 } },
      { index: 3, axis: 'x', rect: { x: 5, y: 0, width: 25, height: 100 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 5, y: 0, width: 20, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 2,
        rect: { x: 5, y: 80, width: 20, height: 20 },
      },
      {
        index: 2,
        kind: 'turn',
        xCorridorIndex: 3,
        yCorridorIndex: 1,
        rect: { x: 5, y: 0, width: 20, height: 20 },
      },
      {
        index: 3,
        kind: 'turn',
        xCorridorIndex: 3,
        yCorridorIndex: 2,
        rect: { x: 5, y: 80, width: 20, height: 20 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 100] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 3, faceSpan: [0, 100] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const result = searchRoute(
      manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
      routeRequest,
    );

    expect(result.fallback).toBe(false);
    expect(result.metrics.maxLabelsPerCorridor).toBeGreaterThanOrEqual(2);
  });

  it('rejects a turn-to-turn transition whose portal spans meet only at one track', () => {
    const entities = [leaf('from', -10, 0, 10, 10), leaf('to', 30, 20, 10, 10)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 10, height: 10 } },
      { index: 1, axis: 'y', rect: { x: 0, y: 0, width: 20, height: 30 } },
      { index: 2, axis: 'x', rect: { x: 10, y: 20, width: 20, height: 10 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 2,
        yCorridorIndex: 1,
        rect: { x: 10, y: 20, width: 10, height: 10 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 10] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 2, faceSpan: [20, 30] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');

    const result = searchRoute(
      manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
      routeRequest,
    );

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('unreachable');
  });

  it('rejects a point-only turn into a bridge corridor', () => {
    const entities = [leaf('from', -10, 0, 10, 10), leaf('to', 20, 20, 10, 10)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 10, height: 10 } },
      { index: 1, axis: 'y', rect: { x: 0, y: 0, width: 20, height: 30 } },
      { index: 2, axis: 'x', rect: { x: 10, y: 20, width: 10, height: 10 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 2,
        yCorridorIndex: 1,
        rect: { x: 10, y: 20, width: 10, height: 10 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 10] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 2, faceSpan: [20, 30] },
    ];

    const result = searchRoute(
      manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
      request(0, 1, 'right', 'left'),
    );

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('unreachable');
  });

  it('can require a route to visit one repair-selected corridor', () => {
    const entities = [leaf('from', -10, 0, 10, 100), leaf('to', 30, 0, 10, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 15, height: 100 } },
      { index: 1, axis: 'y', rect: { x: 5, y: 0, width: 10, height: 40 } },
      { index: 2, axis: 'y', rect: { x: 5, y: 60, width: 10, height: 40 } },
      { index: 3, axis: 'x', rect: { x: 5, y: 0, width: 25, height: 100 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 5, y: 0, width: 10, height: 15 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 3,
        yCorridorIndex: 1,
        rect: { x: 5, y: 25, width: 10, height: 15 },
      },
      {
        index: 2,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 2,
        rect: { x: 5, y: 60, width: 10, height: 15 },
      },
      {
        index: 3,
        kind: 'turn',
        xCorridorIndex: 3,
        yCorridorIndex: 2,
        rect: { x: 5, y: 85, width: 10, height: 15 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 100] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 3, faceSpan: [0, 100] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const world = manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS);

    const result = searchRoute(world, routeRequest, { requiredCorridorIndex: 2 });

    expect(result.fallback).toBe(false);
    expect(result.route.visits.map((visit) => visit.corridorIndex)).toContain(2);
  });

  it('uses stable numeric ties across repeated symmetric searches', () => {
    const entities = [
      leaf('from', 0, 0, 40, 40),
      leaf('blocker', 100, -10, 40, 60),
      leaf('to', 200, 0, 40, 40),
    ];
    const routeRequest = request(0, 2, 'right', 'left');
    const world = buildWorld(entities, [routeRequest]);
    const signature = (): string => JSON.stringify(searchRoute(world, routeRequest).route.visits);
    const expected = signature();

    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(signature()).toBe(expected);
    }
  });

  it('retries an unreachable preferred graph with escape portals enabled', () => {
    const entities = [leaf('from', -10, 0, 10, 20), leaf('to', 100, 10, 10, 20)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 50, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 50, y: 10, width: 50, height: 20 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'continue',
        axis: 'x',
        negativeCorridorIndex: 0,
        positiveCorridorIndex: 1,
        planeCoordinate: 50,
        crossSpan: [10, 20],
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 1, faceSpan: [10, 30] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const result = searchRoute(
      {
        ...manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
        portalSearchTiers: Uint8Array.of(PORTAL_SEARCH_TIER_ESCAPE),
      },
      routeRequest,
    );

    expect(result.fallback).toBe(false);
    expect(result.searchPass).toBe('escape');
    expect(result.metrics.passCount).toBe(2);
    expect(result.route.visits).toHaveLength(2);
  });

  it('uses a non-point escape shortcut ahead of a point-only preferred detour', () => {
    const entities = [leaf('from', -10, 0, 10, 20), leaf('to', 100, 10, 10, 20)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 50, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 50, y: 10, width: 50, height: 20 } },
      { index: 2, axis: 'y', rect: { x: 40, y: 0, width: 20, height: 30 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 2,
        rect: { x: 40, y: 0, width: 10, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 1,
        yCorridorIndex: 2,
        rect: { x: 50, y: 10, width: 10, height: 20 },
      },
      {
        index: 2,
        kind: 'continue',
        axis: 'x',
        negativeCorridorIndex: 0,
        positiveCorridorIndex: 1,
        planeCoordinate: 50,
        crossSpan: [10, 20],
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 1, faceSpan: [10, 30] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const result = searchRoute(
      {
        ...manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
        portalSearchTiers: Uint8Array.of(
          PORTAL_SEARCH_TIER_PREFERRED,
          PORTAL_SEARCH_TIER_PREFERRED,
          PORTAL_SEARCH_TIER_ESCAPE,
        ),
      },
      routeRequest,
    );

    expect(result.fallback).toBe(false);
    expect(result.searchPass).toBe('escape');
    expect(result.metrics.passCount).toBe(2);
    expect(result.route.visits).toHaveLength(2);
    expect(result.cost?.bendCount).toBe(0);
  });

  it('can hide one portal for an isolated search without mutating the world', () => {
    const entities = [leaf('from', -10, 0, 10, 20), leaf('to', 100, 10, 10, 20)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 50, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 50, y: 10, width: 50, height: 20 } },
      { index: 2, axis: 'y', rect: { x: 40, y: 0, width: 20, height: 30 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 2,
        rect: { x: 40, y: 0, width: 10, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 1,
        yCorridorIndex: 2,
        rect: { x: 50, y: 10, width: 10, height: 20 },
      },
      {
        index: 2,
        kind: 'continue',
        axis: 'x',
        negativeCorridorIndex: 0,
        positiveCorridorIndex: 1,
        planeCoordinate: 50,
        crossSpan: [10, 20],
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 1, faceSpan: [10, 30] },
    ];
    const routeRequest = request(0, 1, 'right', 'left');
    const world: CorridorWorld = {
      ...manualCorridorWorld(entities, corridors, portals, attachments, MANUAL_BOUNDS),
      portalSearchTiers: Uint8Array.of(
        PORTAL_SEARCH_TIER_PREFERRED,
        PORTAL_SEARCH_TIER_PREFERRED,
        PORTAL_SEARCH_TIER_ESCAPE,
      ),
    };

    const incumbent = searchRoute(world, routeRequest);
    const candidate = searchRoute(world, routeRequest, {
      hiddenPortalIndexes: new Set([2]),
    });
    const repeated = searchRoute(world, routeRequest);

    expect(incumbent.searchPass).toBe('escape');
    expect(incumbent.route.visits).toHaveLength(2);
    expect(candidate.fallback).toBe(true);
    expect(candidate.searchPass).toBe('preferred');
    expect(candidate.fallbackReason).toBe('unreachable');
    expect(repeated.route.visits).toEqual(incumbent.route.visits);
  });
});
