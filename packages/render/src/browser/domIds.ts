let instance: string | undefined;
let sequence = 0;

/** IDs must remain distinct when independent renderer bundles share a document. */
export function renderIdPrefix(supplied?: string): string {
  if (supplied !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(supplied)) {
      throw new Error('idPrefix must contain only letters, digits, underscores, or hyphens');
    }
    return supplied;
  }
  instance ??= Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join(
    '-',
  );
  return `er-render-${instance}-${++sequence}`;
}
