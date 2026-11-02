export function addToSet<T>(set: Set<T>, values?: Set<T> | readonly T[]): Set<T> {
  values?.forEach((value) => set.add(value));
  return set;
}
