import { clamp } from '../../rangeUtils.js';
import { compileTrackDesires, type TrackDesire } from './spacingObjective.js';
import { createUnionFind, type UnionFind } from './unionFind.js';

const EPSILON = 1e-6;
const CAPACITY_SEARCH_ITERATIONS = 48;

const MAX_COMPONENT_SOLVER_ITERATIONS = 2_000;
export const COMPONENT_SOLVER_TOLERANCE = 5e-5;

export interface SpacingKernelUnit {
  readonly lower: number;
  readonly upper: number;
  readonly desires: readonly TrackDesire[];
  readonly authored: boolean;
}

/** Largest uniform separation, up to `requested`, admitted by one ordered subset. */
export function maximumFeasibleSpacingGap(
  units: readonly Pick<SpacingKernelUnit, 'lower' | 'upper'>[],
  indexes: readonly number[],
  requested: number,
): number {
  if (indexes.length <= 1 || canFitOrderedSpacingGap(units, indexes, requested)) {
    return requested;
  }
  let low = Number.POSITIVE_INFINITY;
  for (let index = 1; index < indexes.length; index += 1) {
    low = Math.min(low, units[indexes[index]].lower - units[indexes[index - 1]].upper);
  }
  let high = requested;
  for (let iteration = 0; iteration < CAPACITY_SEARCH_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    if (canFitOrderedSpacingGap(units, indexes, middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

export function canFitOrderedSpacingGap(
  units: readonly Pick<SpacingKernelUnit, 'lower' | 'upper'>[],
  indexes: readonly number[] | undefined,
  gap: number,
): boolean {
  const count = indexes?.length ?? units.length;
  let track = units[indexes?.[0] ?? 0]?.lower ?? 0;
  for (let index = 1; index < count; index += 1) {
    const unit = units[indexes?.[index] ?? index];
    track = Math.max(unit.lower, track + gap);
    if (track > unit.upper + EPSILON) {
      return false;
    }
  }
  return true;
}

interface CompiledSpacingUnit {
  readonly lower: number;
  readonly upper: number;
  readonly desired: number;
  readonly desireWeight: number;
  readonly irreducibleDesireCost: number;
  readonly authored: boolean;
}

export interface SpacingGapConstraint {
  readonly before: number;
  readonly after: number;
  readonly gap: number;
}

interface CompiledPathTopology {
  readonly kind: 'path';
  readonly orderedUnitIndexes: readonly number[];
  readonly orderedConstraintIndexes: readonly number[];
}

type CompiledSpacingComponentTopology = CompiledPathTopology | { readonly kind: 'general' };

interface CompiledSpacingComponent {
  readonly unitIndexes: readonly number[];
  readonly constraintIndexes: readonly number[];
  readonly topology: CompiledSpacingComponentTopology;
}

interface CompiledSpacingProblem {
  readonly units: readonly CompiledSpacingUnit[];
  readonly constraints: readonly SpacingGapConstraint[];
  /** Components in ascending order of their first unit index. */
  readonly components: readonly CompiledSpacingComponent[];
  /** Constrained components in ascending order of their first constraint index. */
  readonly constrainedComponents: readonly CompiledSpacingComponent[];
}

/** Mutable solver scratch. Reuse is explicit so independent routing runs never share memory. */
export interface SpacingKernelWorkspace {
  readonly constraintComponentUnionFind: UnionFind;
  capacityFeasibilityValues: Float64Array<ArrayBuffer>;
  projectionBoxResiduals: Float64Array<ArrayBuffer>;
  projectionBeforeResiduals: Float64Array<ArrayBuffer>;
  projectionAfterResiduals: Float64Array<ArrayBuffer>;
  projectionPreviousValues: Float64Array<ArrayBuffer>;
}

export function createSpacingKernelWorkspace(): SpacingKernelWorkspace {
  return {
    constraintComponentUnionFind: createUnionFind(),
    capacityFeasibilityValues: new Float64Array(0),
    projectionBoxResiduals: new Float64Array(0),
    projectionBeforeResiduals: new Float64Array(0),
    projectionAfterResiduals: new Float64Array(0),
    projectionPreviousValues: new Float64Array(0),
  };
}

function retainFloat64Capacity(
  buffer: Float64Array<ArrayBuffer>,
  size: number,
): Float64Array<ArrayBuffer> {
  return size <= buffer.length ? buffer : new Float64Array(Math.max(size, buffer.length * 2, 1));
}

export interface ComponentSolveMetrics {
  readonly converged: boolean;
  /** Quantized constraints/bounds the solver could not honor. */
  readonly quantizationViolationCount: number;
}

/** A zero-gap component is infeasible; callers can map its units back to routes/corridors. */
export class InfeasibleSpacingComponentError extends Error {
  readonly unitIndexes: readonly number[];

  constructor(unitIndexes: readonly number[]) {
    super('corridor spacing: continuation order is infeasible even at zero gap');
    this.name = 'InfeasibleSpacingComponentError';
    this.unitIndexes = [...unitIndexes];
  }
}

export interface CapacityReduction {
  readonly unitIndexes: readonly number[];
  readonly required: number;
  readonly achieved: number;
}

export interface SpacingKernelResult {
  readonly tracks: readonly number[];
  /** Exact realized desire cost per compiled unit, captured with the final quantized tracks. */
  readonly unitCosts: Float64Array<ArrayBuffer>;
  readonly objective: number;
  readonly capacityReductions: readonly CapacityReduction[];
  readonly quantizationReductions: readonly CapacityReduction[];
  readonly metrics: ComponentSolveMetrics;
}

/** Project weighted track desires into feasible bounds and separation constraints. */
export function solveSpacingKernel(
  units: readonly SpacingKernelUnit[],
  constraints: readonly SpacingGapConstraint[],
  workspace: SpacingKernelWorkspace = createSpacingKernelWorkspace(),
): SpacingKernelResult {
  const compiledUnits = units.map((unit): CompiledSpacingUnit => {
    const objective = compileTrackDesires(unit.desires);
    return {
      lower: unit.lower,
      upper: unit.upper,
      desired: objective.track,
      desireWeight: objective.weight,
      irreducibleDesireCost: objective.irreducibleCost,
      authored: unit.authored,
    };
  });
  const problem = buildCompiledSpacingProblem(compiledUnits, constraints, workspace);
  const fitted = fitConstraintCapacity(problem, workspace);
  const projected = solveComponents(problem, fitted.constraints, workspace);
  const quantized = quantizeComponentSolution(compiledUnits, fitted.constraints, projected.values);
  const unitCosts = new Float64Array(compiledUnits.length);
  let objective = 0;
  for (let index = 0; index < compiledUnits.length; index += 1) {
    const unit = compiledUnits[index];
    const displacement = quantized.tracks[index] - unit.desired;
    const cost = unit.irreducibleDesireCost + unit.desireWeight * displacement * displacement;
    unitCosts[index] = cost;
    objective += cost;
  }
  return {
    tracks: quantized.tracks,
    unitCosts,
    objective,
    capacityReductions: fitted.reductions,
    quantizationReductions: [
      ...quantized.boundReductions,
      ...constraintQuantizationReductions(problem, fitted.constraints, quantized.tracks),
    ],
    metrics: {
      converged: projected.converged,
      quantizationViolationCount: quantized.violationCount,
    },
  };
}

function buildCompiledSpacingProblem(
  units: readonly CompiledSpacingUnit[],
  constraints: readonly SpacingGapConstraint[],
  workspace: SpacingKernelWorkspace,
): CompiledSpacingProblem {
  const { constraintComponentUnionFind } = workspace;
  constraintComponentUnionFind.reset(units.length);
  for (const constraint of constraints) {
    constraintComponentUnionFind.unionMin(constraint.before, constraint.after);
  }

  const componentIndexByUnit = new Int32Array(units.length);
  const unitIndexesByComponent: number[][] = [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const componentRoot = constraintComponentUnionFind.find(unitIndex);
    let componentIndex: number;
    if (componentRoot === unitIndex) {
      componentIndex = unitIndexesByComponent.length;
      unitIndexesByComponent.push([]);
    } else {
      componentIndex = componentIndexByUnit[componentRoot];
    }
    componentIndexByUnit[unitIndex] = componentIndex;
    unitIndexesByComponent[componentIndex].push(unitIndex);
  }

  const constraintIndexesByComponent = unitIndexesByComponent.map((): number[] => []);
  const constrainedComponentIndexes: number[] = [];
  constraints.forEach((constraint, constraintIndex) => {
    const componentIndex = componentIndexByUnit[constraint.before];
    const componentConstraintIndexes = constraintIndexesByComponent[componentIndex];
    if (componentConstraintIndexes.length === 0) {
      constrainedComponentIndexes.push(componentIndex);
    }
    componentConstraintIndexes.push(constraintIndex);
  });

  const components = unitIndexesByComponent.map(
    (unitIndexes, componentIndex): CompiledSpacingComponent => {
      const constraintIndexes = constraintIndexesByComponent[componentIndex];
      return {
        unitIndexes,
        constraintIndexes,
        topology: extractDirectedPath(unitIndexes, constraints, constraintIndexes) ?? {
          kind: 'general',
        },
      };
    },
  );

  return {
    units,
    constraints,
    components,
    constrainedComponents: constrainedComponentIndexes.map(
      (componentIndex) => components[componentIndex],
    ),
  };
}

function solveComponents(
  problem: CompiledSpacingProblem,
  constraints: readonly SpacingGapConstraint[],
  workspace: SpacingKernelWorkspace,
): {
  readonly values: number[];
  readonly converged: boolean;
} {
  const { units } = problem;
  // Dykstra must start from the objective's unconstrained point. Starting from
  // individually clamped desires instead projects the wrong point when a box
  // bound later pools with an order constraint.
  const values = units.map((unit) => unit.desired);
  let converged = true;
  for (const component of problem.components) {
    const { constraintIndexes, topology, unitIndexes } = component;
    if (topology.kind === 'path') {
      solveBoundedPavaPath(units, constraints, topology, values);
      continue;
    }
    const componentConverged = projectComponent(
      units,
      unitIndexes,
      constraints,
      constraintIndexes,
      values,
      workspace,
    );
    converged = converged && componentConverged;
  }
  return { values, converged };
}

function extractDirectedPath(
  unitIndexes: readonly number[],
  constraints: readonly SpacingGapConstraint[],
  constraintIndexes: readonly number[],
): CompiledPathTopology | undefined {
  if (unitIndexes.length === 1) {
    return constraintIndexes.length === 0
      ? { kind: 'path', orderedUnitIndexes: [...unitIndexes], orderedConstraintIndexes: [] }
      : undefined;
  }
  if (constraintIndexes.length !== unitIndexes.length - 1) {
    return undefined;
  }

  const incomingByUnit = new Map<number, number>();
  const outgoingByUnit = new Map<number, number>();
  for (const constraintIndex of constraintIndexes) {
    const constraint = constraints[constraintIndex];
    if (
      constraint.before === constraint.after ||
      outgoingByUnit.has(constraint.before) ||
      incomingByUnit.has(constraint.after)
    ) {
      return undefined;
    }
    outgoingByUnit.set(constraint.before, constraintIndex);
    incomingByUnit.set(constraint.after, constraintIndex);
  }

  const starts = unitIndexes.filter((unitIndex) => !incomingByUnit.has(unitIndex));
  const ends = unitIndexes.filter((unitIndex) => !outgoingByUnit.has(unitIndex));
  if (starts.length !== 1 || ends.length !== 1) {
    return undefined;
  }
  for (const unitIndex of unitIndexes) {
    const incomingCount = incomingByUnit.has(unitIndex) ? 1 : 0;
    const outgoingCount = outgoingByUnit.has(unitIndex) ? 1 : 0;
    if (unitIndex === starts[0]) {
      if (incomingCount !== 0 || outgoingCount !== 1) {
        return undefined;
      }
    } else if (unitIndex === ends[0]) {
      if (incomingCount !== 1 || outgoingCount !== 0) {
        return undefined;
      }
    } else if (incomingCount !== 1 || outgoingCount !== 1) {
      return undefined;
    }
  }

  const pathUnitIndexes: number[] = [];
  const pathConstraintIndexes: number[] = [];
  const visited = new Set<number>();
  let current: number | undefined = starts[0];
  while (current !== undefined) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    pathUnitIndexes.push(current);
    const outgoingIndex = outgoingByUnit.get(current);
    if (outgoingIndex === undefined) {
      current = undefined;
      continue;
    }
    pathConstraintIndexes.push(outgoingIndex);
    current = constraints[outgoingIndex].after;
  }
  if (
    pathUnitIndexes.length !== unitIndexes.length ||
    pathConstraintIndexes.length !== constraintIndexes.length
  ) {
    return undefined;
  }
  return {
    kind: 'path',
    orderedUnitIndexes: pathUnitIndexes,
    orderedConstraintIndexes: pathConstraintIndexes,
  };
}

interface PavaBlock {
  readonly start: number;
  readonly end: number;
  readonly weight: number;
  readonly weightedTarget: number;
  readonly lower: number;
  readonly upper: number;
  readonly value: number;
}

function pavaBlockValue(
  weightedTarget: number,
  weight: number,
  lower: number,
  upper: number,
): number {
  if (lower > upper) {
    if (lower - upper > EPSILON) {
      throw new Error(
        `corridor spacing: infeasible bounds in path component (${lower} > ${upper})`,
      );
    }
    return (lower + upper) / 2;
  }
  return clamp(weightedTarget / weight, lower, upper);
}

function solveBoundedPavaPath(
  units: readonly CompiledSpacingUnit[],
  constraints: readonly SpacingGapConstraint[],
  path: CompiledPathTopology,
  values: number[],
): void {
  // Removing cumulative gaps turns x[i + 1] >= x[i] + gap[i] into an
  // ordinary isotonic y[i] <= y[i + 1] problem.
  const offsets = new Float64Array(path.orderedUnitIndexes.length);
  for (let index = 1; index < offsets.length; index += 1) {
    offsets[index] = offsets[index - 1] + constraints[path.orderedConstraintIndexes[index - 1]].gap;
  }

  const lowerBounds = new Float64Array(path.orderedUnitIndexes.length);
  // Monotonicity propagates every lower bound forward and every upper bound
  // backward. These normalized bounds are equivalent to the original boxes.
  let propagatedLower = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < path.orderedUnitIndexes.length; index += 1) {
    const unit = units[path.orderedUnitIndexes[index]];
    propagatedLower = Math.max(propagatedLower, unit.lower - offsets[index]);
    lowerBounds[index] = propagatedLower;
  }
  const upperBounds = new Float64Array(path.orderedUnitIndexes.length);
  let propagatedUpper = Number.POSITIVE_INFINITY;
  for (let index = path.orderedUnitIndexes.length - 1; index >= 0; index -= 1) {
    const unit = units[path.orderedUnitIndexes[index]];
    propagatedUpper = Math.min(propagatedUpper, unit.upper - offsets[index]);
    upperBounds[index] = propagatedUpper;
  }

  const blocks: PavaBlock[] = [];
  for (let index = 0; index < path.orderedUnitIndexes.length; index += 1) {
    const unit = units[path.orderedUnitIndexes[index]];
    const weightedTarget = unit.desireWeight * (unit.desired - offsets[index]);
    blocks.push({
      start: index,
      end: index,
      weight: unit.desireWeight,
      weightedTarget,
      lower: lowerBounds[index],
      upper: upperBounds[index],
      value: pavaBlockValue(
        weightedTarget,
        unit.desireWeight,
        lowerBounds[index],
        upperBounds[index],
      ),
    });
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.value <= right.value) {
        break;
      }
      blocks.pop();
      blocks.pop();
      const weight = left.weight + right.weight;
      const mergedWeightedTarget = left.weightedTarget + right.weightedTarget;
      const lower = Math.max(left.lower, right.lower);
      const upper = Math.min(left.upper, right.upper);
      blocks.push({
        start: left.start,
        end: right.end,
        weight,
        weightedTarget: mergedWeightedTarget,
        lower,
        upper,
        value: pavaBlockValue(mergedWeightedTarget, weight, lower, upper),
      });
    }
  }

  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) {
      values[path.orderedUnitIndexes[index]] = block.value + offsets[index];
    }
  }
}

function projectComponent(
  units: readonly CompiledSpacingUnit[],
  unitIndexes: readonly number[],
  constraints: readonly SpacingGapConstraint[],
  constraintIndexes: readonly number[],
  values: number[],
  workspace: SpacingKernelWorkspace,
): boolean {
  workspace.projectionBoxResiduals = retainFloat64Capacity(
    workspace.projectionBoxResiduals,
    units.length,
  );
  workspace.projectionBeforeResiduals = retainFloat64Capacity(
    workspace.projectionBeforeResiduals,
    constraintIndexes.length,
  );
  workspace.projectionAfterResiduals = retainFloat64Capacity(
    workspace.projectionAfterResiduals,
    constraintIndexes.length,
  );
  workspace.projectionPreviousValues = retainFloat64Capacity(
    workspace.projectionPreviousValues,
    unitIndexes.length,
  );
  const {
    projectionAfterResiduals,
    projectionBeforeResiduals,
    projectionBoxResiduals,
    projectionPreviousValues,
  } = workspace;
  for (const unitIndex of unitIndexes) {
    projectionBoxResiduals[unitIndex] = 0;
  }
  projectionBeforeResiduals.fill(0, 0, constraintIndexes.length);
  projectionAfterResiduals.fill(0, 0, constraintIndexes.length);
  for (let iteration = 1; iteration <= MAX_COMPONENT_SOLVER_ITERATIONS; iteration += 1) {
    for (let index = 0; index < unitIndexes.length; index += 1) {
      projectionPreviousValues[index] = values[unitIndexes[index]];
    }
    let maximumResidualChange = 0;
    for (const unitIndex of unitIndexes) {
      const corrected = values[unitIndex] + projectionBoxResiduals[unitIndex];
      const projected = clamp(corrected, units[unitIndex].lower, units[unitIndex].upper);
      values[unitIndex] = projected;
      const residual = corrected - projected;
      maximumResidualChange = Math.max(
        maximumResidualChange,
        Math.abs(residual - projectionBoxResiduals[unitIndex]),
      );
      projectionBoxResiduals[unitIndex] = residual;
    }
    constraintIndexes.forEach((constraintIndex, componentConstraintIndex) => {
      const constraint = constraints[constraintIndex];
      const correctedBefore =
        values[constraint.before] + projectionBeforeResiduals[componentConstraintIndex];
      const correctedAfter =
        values[constraint.after] + projectionAfterResiduals[componentConstraintIndex];
      const violation = constraint.gap - (correctedAfter - correctedBefore);
      let projectedBefore = correctedBefore;
      let projectedAfter = correctedAfter;
      if (violation > 0) {
        const beforeWeight = units[constraint.before].desireWeight;
        const afterWeight = units[constraint.after].desireWeight;
        projectedBefore -= (violation * afterWeight) / (beforeWeight + afterWeight);
        projectedAfter += (violation * beforeWeight) / (beforeWeight + afterWeight);
      }
      values[constraint.before] = projectedBefore;
      values[constraint.after] = projectedAfter;
      const beforeResidual = correctedBefore - projectedBefore;
      const afterResidual = correctedAfter - projectedAfter;
      maximumResidualChange = Math.max(
        maximumResidualChange,
        Math.abs(beforeResidual - projectionBeforeResiduals[componentConstraintIndex]),
        Math.abs(afterResidual - projectionAfterResiduals[componentConstraintIndex]),
      );
      projectionBeforeResiduals[componentConstraintIndex] = beforeResidual;
      projectionAfterResiduals[componentConstraintIndex] = afterResidual;
    });
    let maximumChange = 0;
    let maximumViolation = 0;
    for (let index = 0; index < unitIndexes.length; index += 1) {
      const unitIndex = unitIndexes[index];
      maximumChange = Math.max(
        maximumChange,
        Math.abs(values[unitIndex] - projectionPreviousValues[index]),
      );
      maximumViolation = Math.max(
        maximumViolation,
        units[unitIndex].lower - values[unitIndex],
        values[unitIndex] - units[unitIndex].upper,
      );
    }
    for (const constraintIndex of constraintIndexes) {
      const constraint = constraints[constraintIndex];
      maximumViolation = Math.max(
        maximumViolation,
        constraint.gap - (values[constraint.after] - values[constraint.before]),
      );
    }
    if (
      maximumChange <= COMPONENT_SOLVER_TOLERANCE &&
      maximumResidualChange <= COMPONENT_SOLVER_TOLERANCE &&
      maximumViolation <= COMPONENT_SOLVER_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
}

function fitConstraintCapacity(
  problem: CompiledSpacingProblem,
  workspace: SpacingKernelWorkspace,
): {
  readonly constraints: readonly SpacingGapConstraint[];
  readonly reductions: readonly CapacityReduction[];
} {
  const { constraints, units } = problem;
  let fitted: SpacingGapConstraint[] | undefined;
  const reductions: CapacityReduction[] = [];
  workspace.capacityFeasibilityValues = retainFloat64Capacity(
    workspace.capacityFeasibilityValues,
    units.length,
  );
  const { capacityFeasibilityValues } = workspace;
  for (const component of problem.constrainedComponents) {
    const { constraintIndexes, unitIndexes } = component;
    if (
      constraintsFeasible(
        units,
        constraints,
        unitIndexes,
        constraintIndexes,
        1,
        capacityFeasibilityValues,
      )
    ) {
      continue;
    }
    if (
      !constraintsFeasible(
        units,
        constraints,
        unitIndexes,
        constraintIndexes,
        0,
        capacityFeasibilityValues,
      )
    ) {
      throw new InfeasibleSpacingComponentError(unitIndexes);
    }
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < CAPACITY_SEARCH_ITERATIONS; iteration += 1) {
      const middle = (low + high) / 2;
      if (
        constraintsFeasible(
          units,
          constraints,
          unitIndexes,
          constraintIndexes,
          middle,
          capacityFeasibilityValues,
        )
      ) {
        low = middle;
      } else {
        high = middle;
      }
    }
    let maxGap = Number.NEGATIVE_INFINITY;
    for (const constraintIndex of constraintIndexes) {
      maxGap = Math.max(maxGap, constraints[constraintIndex].gap);
    }
    reductions.push({
      unitIndexes: component.unitIndexes,
      required: Math.max(0, maxGap),
      achieved: Math.max(0, maxGap * low),
    });
    if (!fitted) {
      fitted = constraints.slice();
    }
    const mutableFitted = fitted;
    for (const constraintIndex of constraintIndexes) {
      const constraint = constraints[constraintIndex];
      mutableFitted[constraintIndex] = {
        ...constraint,
        gap: constraint.gap > 0 ? constraint.gap * low : constraint.gap,
      };
    }
  }
  return {
    constraints: fitted ?? constraints,
    reductions,
  };
}

function constraintsFeasible(
  units: readonly CompiledSpacingUnit[],
  constraints: readonly SpacingGapConstraint[],
  unitIndexes: readonly number[],
  constraintIndexes: readonly number[],
  scale: number,
  values: Float64Array,
): boolean {
  for (const unitIndex of unitIndexes) {
    values[unitIndex] = units[unitIndex].lower;
  }
  for (let iteration = 0; iteration <= unitIndexes.length; iteration += 1) {
    let changed = false;
    for (const constraintIndex of constraintIndexes) {
      const constraint = constraints[constraintIndex];
      const gap = constraint.gap > 0 ? constraint.gap * scale : constraint.gap;
      const candidate = values[constraint.before] + gap;
      if (candidate <= values[constraint.after]) {
        continue;
      }
      if (candidate > units[constraint.after].upper) {
        return false;
      }
      values[constraint.after] = candidate;
      changed = true;
    }
    if (!changed) {
      return true;
    }
  }
  return false;
}

function quantizeComponentSolution(
  units: readonly CompiledSpacingUnit[],
  constraints: readonly SpacingGapConstraint[],
  projected: readonly number[],
): {
  readonly tracks: readonly number[];
  readonly boundReductions: readonly CapacityReduction[];
  readonly violationCount: number;
} {
  const boundReductions: CapacityReduction[] = [];
  const values = units.map((unit, index) => {
    if (unit.authored) {
      return clamp(projected[index], unit.lower, unit.upper);
    }
    const lower = Math.ceil(unit.lower - EPSILON);
    const upper = Math.floor(unit.upper + EPSILON);
    if (lower <= upper) {
      return clamp(Math.round(projected[index]), lower, upper);
    }
    boundReductions.push({
      unitIndexes: [index],
      required: 0,
      achieved: unit.upper - unit.lower,
    });
    return projected[index];
  });
  for (let iteration = 0; iteration <= units.length + constraints.length; iteration += 1) {
    let changed = false;
    for (const constraint of constraints) {
      const requiredGap = Math.floor(constraint.gap + EPSILON);
      const violation = requiredGap - (values[constraint.after] - values[constraint.before]);
      if (violation <= EPSILON) {
        continue;
      }
      const after = units[constraint.after];
      const afterTarget = after.authored
        ? values[constraint.after] + violation
        : Math.ceil(values[constraint.after] + violation - EPSILON);
      const nextAfter = Math.min(after.upper, afterTarget);
      if (nextAfter > values[constraint.after] + EPSILON) {
        values[constraint.after] = nextAfter;
        changed = true;
      }
      const remaining = requiredGap - (values[constraint.after] - values[constraint.before]);
      if (remaining > EPSILON) {
        const before = units[constraint.before];
        const beforeTarget = before.authored
          ? values[constraint.before] - remaining
          : Math.floor(values[constraint.before] - remaining + EPSILON);
        const nextBefore = Math.max(before.lower, beforeTarget);
        if (nextBefore < values[constraint.before] - EPSILON) {
          values[constraint.before] = nextBefore;
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  let violationCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const unit = units[index];
    if (values[index] < unit.lower - EPSILON || values[index] > unit.upper + EPSILON) {
      values[index] = clamp(values[index], unit.lower, unit.upper);
      violationCount += 1;
    }
  }
  violationCount += constraints.filter(
    (constraint) =>
      values[constraint.after] - values[constraint.before] <
      Math.floor(constraint.gap + EPSILON) - EPSILON,
  ).length;
  return { tracks: values, boundReductions, violationCount };
}

function constraintQuantizationReductions(
  problem: CompiledSpacingProblem,
  constraints: readonly SpacingGapConstraint[],
  tracks: readonly number[],
): CapacityReduction[] {
  const reductions: CapacityReduction[] = [];
  for (const component of problem.constrainedComponents) {
    const { constraintIndexes } = component;
    let required = Number.NEGATIVE_INFINITY;
    let achieved = Number.POSITIVE_INFINITY;
    let reduced = false;
    for (const constraintIndex of constraintIndexes) {
      const constraint = constraints[constraintIndex];
      const constraintAchieved = tracks[constraint.after] - tracks[constraint.before];
      required = Math.max(required, constraint.gap);
      achieved = Math.min(achieved, constraintAchieved);
      reduced = reduced || constraintAchieved + EPSILON < constraint.gap;
    }
    if (!reduced) {
      continue;
    }
    reductions.push({
      unitIndexes: component.unitIndexes,
      required,
      achieved,
    });
  }
  return reductions;
}
