export interface TrackDesire {
  readonly kind: 'corridor-ideal' | 'terminal' | 'terminal-lead' | 'terminal-window' | 'u-turn';
  readonly track: number;
  readonly weight: number;
}

export function compileTrackDesires(desires: readonly TrackDesire[]) {
  if (desires.length === 0) {
    throw new Error('corridor spacing: track unit has no desires');
  }
  const hasSemanticDesire = desires.some((desire) => desire.kind !== 'corridor-ideal');
  let weight = 0;
  let weightedTracks = 0;
  let weightedSquares = 0;
  for (const desire of desires) {
    if (!(desire.weight > 0)) {
      throw new Error(`corridor spacing: ${desire.kind} desire has non-positive weight`);
    }
    if (hasSemanticDesire && desire.kind === 'corridor-ideal') {
      continue;
    }
    const weightedTrack = desire.track * desire.weight;
    weight += desire.weight;
    weightedTracks += weightedTrack;
    weightedSquares += weightedTrack * desire.track;
  }
  const track = weightedTracks / weight;
  return {
    track,
    weight,
    irreducibleCost: Math.max(0, weightedSquares - weightedTracks * track),
  };
}
