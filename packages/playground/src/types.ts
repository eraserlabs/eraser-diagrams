export interface Scenario {
  id: string;
  label: string;
  description: string;
  /** Dropdown optgroup this scenario lists under. */
  group?: string;
  /** The document envelope handed to the engine — `{ elements }` or `{ entities, connections }`. */
  input: unknown;
}

/** The subset of an OpenAPI 3.1 document the custom reference renders. */
export interface OpenApiParam {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string };
}
export interface OpenApiResponse {
  description?: string;
}
export interface OpenApiOperation {
  summary?: string;
  parameters?: OpenApiParam[];
  requestBody?: { required?: boolean };
  responses?: Record<string, OpenApiResponse>;
}
export interface OpenApiDoc {
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
}
