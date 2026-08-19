import type { LayoutEntity } from '../../types.js';
import { LayoutManager } from '../../LayoutManager.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import type {
  Corridor,
  PortalRef,
  RouteSearchRequest,
  TerminalAttachment,
} from '../corridor/contract.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { searchRoute } from '../corridor/topology.js';
import {
  PORTAL_SEARCH_TIER_ESCAPE,
  PORTAL_SEARCH_TIER_PREFERRED,
  type CorridorWorld,
} from '../corridor/world.js';

function buildWorld(
  entities: readonly LayoutEntity[],
  requests: readonly RouteSearchRequest[],
): CorridorWorld {
  return buildCorridorWorld(
    new LayoutManager({ entities: [...entities], connections: [] }),
    requests,
  );
}

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
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

function manualWorld(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  portals: readonly PortalRef[],
  attachments: readonly TerminalAttachment[],
  options: {
    readonly portalSearchTiers?: Uint8Array;
  } = {},
): CorridorWorld {
  const bounds = { x: -20, y: -20, width: 80, height: 140 };
  return {
    bounds,
    entities,
    indexer: new CorridorIndexer(
      corridors,
      portals,
      attachments,
      new LayoutManager({ entities: [...entities], connections: [] }),
      bounds,
    ),
    portalSearchTiers: options.portalSearchTiers,
  };
}

describe('routing corridor feasible-interval topology', () => {
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

    const result = searchRoute(manualWorld(entities, corridors, [], attachments), routeRequest);

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
    const world = manualWorld(entities, corridors, [], attachments);

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
    const result = search(
      [
        leaf('from', 0, 0, 40, 40),
        leaf('to', 600, 0, 40, 40),
        leaf('above', 200, -100, 60, 80),
        leaf('below', 400, 60, 60, 80),
      ],
      routeRequest,
    );

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
    const result = searchRoute(manualWorld(entities, corridors, [], attachments), routeRequest);

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
      manualWorld(entities, corridors, portals, attachments),
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
      manualWorld(entities, corridors, portals, attachments),
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
      manualWorld(entities, corridors, portals, attachments),
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
    const world = manualWorld(entities, corridors, portals, attachments);

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
      manualWorld(entities, corridors, portals, attachments, {
        portalSearchTiers: Uint8Array.of(PORTAL_SEARCH_TIER_ESCAPE),
      }),
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
      manualWorld(entities, corridors, portals, attachments, {
        portalSearchTiers: Uint8Array.of(
          PORTAL_SEARCH_TIER_PREFERRED,
          PORTAL_SEARCH_TIER_PREFERRED,
          PORTAL_SEARCH_TIER_ESCAPE,
        ),
      }),
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
    const world = manualWorld(entities, corridors, portals, attachments, {
      portalSearchTiers: Uint8Array.of(
        PORTAL_SEARCH_TIER_PREFERRED,
        PORTAL_SEARCH_TIER_PREFERRED,
        PORTAL_SEARCH_TIER_ESCAPE,
      ),
    });

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
