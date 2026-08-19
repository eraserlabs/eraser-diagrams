import type { RegistryInfo } from '@eraserlabs/resolve';

export async function getRegistry(): Promise<RegistryInfo> {
  return (await fetch('/registry')).json() as Promise<RegistryInfo>;
}

/** A tag's full JSON Schema, served verbatim. Shape is open — the explorer reads it structurally. */
export async function getTagSchema(tag: string): Promise<Record<string, unknown>> {
  return (await fetch(`/registry/schema/${encodeURIComponent(tag)}`)).json() as Promise<
    Record<string, unknown>
  >;
}

export async function getHealth(): Promise<{ status: string } | undefined> {
  try {
    const res = await fetch('/health');

    return (await res.json()) as { status: string };
  } catch {
    return undefined;
  }
}
