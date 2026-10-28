import type { Direction } from '../types.js';
import { LayoutRange } from '../types.js';
import { LayoutManager } from '../LayoutManager.js';
import { generateChangesForMove } from '../calculateChanges.js';
import type { RepairPolicy } from '../routing/executeCorridorRouting.js';
import { combineRanges, shiftRange } from '../rangeUtils.js';
import { Rank, RankData, getEntityIdsForRanks, calculateRankMetrics } from './ranks.js';

interface CutAndShiftArgs {
  layoutManager: LayoutManager;
  rankData: RankData;
  repair: RepairPolicy;
  idealAspectRatio: number;
  maxCuts?: number;
  padding?: number;
  penaltyMultiples?: PenaltyMultiples;
}

interface PenaltyMultiples {
  aspect: number;
  cuts: number;
  rowVariance: number;
}

interface CuttingSolution {
  cutPoints: number[];
  cost: number;
}

interface CostCalculationArgs {
  aspectRatio: number;
  idealAspectRatio: number;
  numCuts: number;
  segmentDimensions: number[]; // Width for horizontal, height for vertical layouts
  penaltyMultiples: PenaltyMultiples;
}

export interface CutAndShiftResult {
  cost: number;
  didChange: boolean;
  cutPoints: number[];
}

const DEFAULT_PENALTY_MULTIPLES: PenaltyMultiples = {
  aspect: 1.0,
  cuts: 0.25,
  rowVariance: 0.5,
};

export function cutAndShift(args: CutAndShiftArgs): CutAndShiftResult {
  if (args.layoutManager.getEntities().length <= 5) {
    return {
      cost: 0,
      didChange: false,
      cutPoints: [],
    };
  }

  const {
    layoutManager,
    rankData,
    repair,
    idealAspectRatio,
    maxCuts = 3,
    padding = 50,
    penaltyMultiples = DEFAULT_PENALTY_MULTIPLES,
  } = args;

  // Find valid cut points (ranks where we can cut)
  const validCutRanks = findValidCutRanks(rankData.ranks);
  const bounds = layoutManager.getDims();

  // Calculate baseline cost (no cuts, no row variance)
  const baselineCost = calculateCost({
    aspectRatio: calculateAspectRatio(bounds),
    idealAspectRatio,
    numCuts: 0,
    segmentDimensions: [], // No segments for baseline
    penaltyMultiples,
  });

  if (validCutRanks.length === 0) {
    return {
      cost: baselineCost,
      didChange: false,
      cutPoints: [],
    };
  }

  const rankMetrics = calculateRankMetrics(layoutManager, rankData);

  const optimalSolution = findOptimalCuttingSolution(
    validCutRanks,
    rankMetrics,
    idealAspectRatio,
    maxCuts,
    baselineCost,
    layoutManager.primaryDirection,
    padding,
    penaltyMultiples,
    bounds,
  );

  const shouldApplyShift =
    optimalSolution.cutPoints.length > 0 && optimalSolution.cost < baselineCost;

  if (shouldApplyShift) {
    applyShift(layoutManager, rankData, optimalSolution.cutPoints, padding, repair);
  }

  return {
    cost: optimalSolution.cost,
    didChange: shouldApplyShift,
    cutPoints: optimalSolution.cutPoints,
  };
}

/**
 * Find ranks where we can make valid cuts
 * A rank is valid for cutting if it meets our cutting criteria
 */
function findValidCutRanks(ranks: Rank[]): number[] {
  const validCutRanks: number[] = [];

  for (let rankIndex = 0; rankIndex < ranks.length - 1; rankIndex++) {
    const rank = ranks[rankIndex];

    // Skip empty ranks
    if (rank.nodes.length === 0) {
      continue;
    }

    // No point in cutting if there is nothing left after
    if (rank.out.length === 0) {
      continue;
    }

    // Cannot cut when splitting into the next rank
    if (rank.outRanks.filter((rank) => rank === rankIndex + 1).length > 1) {
      continue;
    }

    validCutRanks.push(rankIndex);
  }

  return validCutRanks;
}

/**
 * Calculate the total cost including aspect ratio, cuts, and row variance penalties
 */
function calculateCost(args: CostCalculationArgs): number {
  const { aspectRatio, idealAspectRatio, numCuts, segmentDimensions, penaltyMultiples } = args;

  // Aspect ratio penalty using log scale (symmetric for over/under)
  const aspectPenalty = calcDeviation(aspectRatio, idealAspectRatio) * penaltyMultiples.aspect;

  // Cut penalty (linear with number of cuts)
  const cutPenalty = numCuts * penaltyMultiples.cuts;

  // Row variance penalty (penalize uneven row/column sizes)
  let variancePenalty = 0;
  if (segmentDimensions.length > 1) {
    const mean = segmentDimensions.reduce((sum, dim) => sum + dim, 0) / segmentDimensions.length;
    const variance =
      segmentDimensions.reduce((sum, dim) => sum + calcDeviation(dim, mean), 0) /
      segmentDimensions.length;

    // Normalize by mean to get coefficient of variation
    variancePenalty = variance * penaltyMultiples.rowVariance;
  }

  return aspectPenalty + cutPenalty + variancePenalty;
}

function calcDeviation(a: number, b: number) {
  return a > b ? a / b : b / a;
}

/**
 * Find the optimal cutting solution by evaluating complete solutions
 */
function findOptimalCuttingSolution(
  validCutRanks: number[],
  rankMetrics: LayoutRange[],
  idealAspectRatio: number,
  maxCutsArg: number,
  baselineCost: number,
  primaryDirection: Direction,
  padding: number,
  penaltyMultiples: PenaltyMultiples,
  initialBounds: LayoutRange,
): CuttingSolution {
  const maxCuts = Math.min(validCutRanks.length, maxCutsArg); // Limit search space for performance
  let bestSolution: CuttingSolution = { cutPoints: [], cost: baselineCost };

  // Try all possible combinations of cuts (including no cuts)
  for (let numCuts = 1; numCuts <= maxCuts; numCuts++) {
    const combinations = getCombinations(validCutRanks, numCuts);

    for (const cutCombination of combinations) {
      const solution = evaluateCuttingSolution(
        cutCombination,
        rankMetrics,
        idealAspectRatio,
        primaryDirection,
        padding,
        penaltyMultiples,
        initialBounds,
      );

      if (solution.cost < bestSolution.cost) {
        bestSolution = solution;
      }
    }
  }

  return bestSolution;
}

/**
 * Generate all combinations of size k from the given array
 * @todo We can get a lot of perf wins by using heuristics to prune these and / or build a likely solution set
 * This stems from the fact that we know we want roughly even rows and we know roughly how long each should be
 */
function getCombinations<T>(arr: T[], k: number): T[][] {
  // Sanity checks - we should be calling with 1 <= k <= arr.length
  if (k === 0) {
    return [[]];
  }
  if (k > arr.length) {
    return [];
  }

  const result: T[][] = [];

  function backtrack(start: number, current: T[]) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }

    for (let i = start; i <= arr.length - (k - current.length); i++) {
      current.push(arr[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  backtrack(0, []);
  return result;
}

/**
 * Calculate all segments that would result from the given cut points
 */
function calculateSegmentsFromCuts(cutPoints: number[], rankMetrics: LayoutRange[]): LayoutRange[] {
  const sortedCuts = [...cutPoints].sort((a, b) => a - b);
  const segments: LayoutRange[] = [];

  let startRank = 0;

  // Create segments between cuts
  for (const cutRank of sortedCuts) {
    const segmentBounds = combineRanges(...rankMetrics.slice(startRank, cutRank + 1));
    segments.push(segmentBounds);
    startRank = cutRank + 1;
  }

  // Add final segment from last cut to end
  if (startRank < rankMetrics.length) {
    const finalSegment = combineRanges(...rankMetrics.slice(startRank));
    segments.push(finalSegment);
  }

  return segments;
}

function calculateAspectRatio(bounds: LayoutRange): number {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return height > 0 ? width / height : 1;
}

/**
 * Apply the shift by moving entities after the cut points
 */
function applyShift(
  layoutManager: LayoutManager,
  rankData: RankData,
  cutPoints: number[],
  padding: number,
  repair: RepairPolicy,
): void {
  const rankMetrics = calculateRankMetrics(layoutManager, rankData);

  // Calculate the complete layout transformation
  const layoutResult = calculateLayoutWithCuts(
    cutPoints,
    rankMetrics,
    layoutManager.primaryDirection,
    padding,
    layoutManager.getDims(),
  );

  const sortedCutPoints = [...cutPoints].sort((a, b) => a - b);

  // Apply deltas to each segment
  for (let segmentIndex = 0; segmentIndex < layoutResult.segmentDeltas.length; segmentIndex++) {
    const delta = layoutResult.segmentDeltas[segmentIndex];

    // Skip the first segment as it doesn't move (delta should be 0,0)
    if (segmentIndex === 0) {
      continue;
    }

    // Determine which ranks belong to this segment
    const startRank = segmentIndex === 0 ? 0 : sortedCutPoints[segmentIndex - 1] + 1;
    const endRank =
      segmentIndex === sortedCutPoints.length
        ? rankData.ranks.length - 1
        : sortedCutPoints[segmentIndex];

    // Get all entity IDs in this segment
    const entityIdsToShift = getEntityIdsForRanks(rankData, startRank, endRank);

    if (entityIdsToShift.size === 0) {
      continue;
    }

    // Apply the shift using generateChangesForMove
    generateChangesForMove(layoutManager, entityIdsToShift, delta, { repair });
  }
}

interface CutLayoutResult {
  finalBounds: LayoutRange;
  segmentBounds: LayoutRange[]; // Where each segment ends up after shifts
  segmentDeltas: Array<{ deltaX: number; deltaY: number }>; // How much each segment moved
}

/**
 * Calculate the complete layout transformation for all cuts at once
 * This handles the cumulative effect of multiple cuts and maintains proper reference points
 */
function calculateLayoutWithCuts(
  cutPoints: number[],
  rankMetrics: LayoutRange[],
  primaryDirection: Direction,
  padding: number,
  initialBounds: LayoutRange,
): CutLayoutResult {
  // Calculate original segments from cuts
  const originalSegments = calculateSegmentsFromCuts(cutPoints, rankMetrics);

  // Remember the initial reference point for alignment
  const referenceX = initialBounds.minX;
  const referenceY = initialBounds.minY;

  const segmentBounds: LayoutRange[] = [];
  const segmentDeltas: Array<{ deltaX: number; deltaY: number }> = [];

  // Track current position for placing segments
  let nextSegmentX = referenceX;
  let nextSegmentY = referenceY;

  for (let segmentIndex = 0; segmentIndex < originalSegments.length; segmentIndex++) {
    const currentSegment = originalSegments[segmentIndex];
    let finalSegment = currentSegment;

    let deltaX: number;
    let deltaY: number;

    if (segmentIndex === 0) {
      // First segment stays in place
      deltaX = 0;
      deltaY = 0;
    } else {
      // Calculate delta to move segment to its new position
      if (primaryDirection === 'right' || primaryDirection === 'left') {
        // Horizontal layout: align to reference X, move to current Y
        deltaX = referenceX - currentSegment.minX;
        deltaY = nextSegmentY - currentSegment.minY;
      } else {
        // Vertical layout: align to reference Y, move to current X
        deltaX = nextSegmentX - currentSegment.minX;
        deltaY = referenceY - currentSegment.minY;
      }

      finalSegment = shiftRange(currentSegment, { deltaX, deltaY });
    }

    segmentBounds.push(finalSegment);
    segmentDeltas.push({ deltaX, deltaY });

    // Update current position for next segment AFTER processing this segment
    if (primaryDirection === 'right' || primaryDirection === 'left') {
      // Move down by this segment max relative to the current position, plus padding
      nextSegmentY = finalSegment.maxY + padding;
    } else {
      // Move right by this segment max relative to the current position, plus padding
      nextSegmentX = finalSegment.maxX + padding;
    }
  }

  // Calculate final overall bounds
  const finalBounds = combineRanges(...segmentBounds);

  return {
    finalBounds,
    segmentBounds,
    segmentDeltas,
  };
}

/**
 * Evaluate a complete cutting solution by calculating the final layout aspect ratio
 */
function evaluateCuttingSolution(
  cutPoints: number[],
  rankMetrics: LayoutRange[],
  idealAspectRatio: number,
  primaryDirection: Direction,
  padding: number,
  penaltyMultiples: PenaltyMultiples,
  initialBounds: LayoutRange,
): CuttingSolution {
  // Calculate the complete layout transformation
  const layoutResult = calculateLayoutWithCuts(
    cutPoints,
    rankMetrics,
    primaryDirection,
    padding,
    initialBounds,
  );

  // Calculate final aspect ratio from the predicted final bounds
  const finalAspectRatio = calculateAspectRatio(layoutResult.finalBounds);

  // Calculate segment dimensions for row variance penalty
  const segmentDimensions = layoutResult.segmentBounds.map((segment) => {
    if (primaryDirection === 'right' || primaryDirection === 'left') {
      // For horizontal layouts, we care about row widths
      return segment.maxX - segment.minX;
    } else {
      // For vertical layouts, we care about column heights
      return segment.maxY - segment.minY;
    }
  });

  const cost = calculateCost({
    aspectRatio: finalAspectRatio,
    idealAspectRatio,
    numCuts: cutPoints.length,
    segmentDimensions,
    penaltyMultiples,
  });

  return {
    cutPoints,
    cost,
  };
}
