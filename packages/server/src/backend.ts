import type { RegistryInfo, ValidationResult } from '@eraserlabs/resolve';

/**
 * What the browserless routes need from whatever backs the server — satisfied structurally by
 * both a bare `Resolver` and a full `Diagrams` orchestrator.
 */
export interface ServerBackend {
  validate(input: unknown): Promise<ValidationResult>;
  registryInfo(): RegistryInfo;
  tagSchema(tag: string): object | undefined;
}
