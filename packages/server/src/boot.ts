import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { createResolver, ERROR_CODE, SEVERITY } from '@eraserlabs/resolve';
import {
  createEraserIconLoader,
  createRenderer,
  stockLibrary,
  stageFonts,
} from '@eraserlabs/diagrams';
import { loadConfig, type ServerConfig } from './config.js';
import { registerValidate } from './routes/validate.js';
import { registerRegistry } from './routes/registry.js';
import { registerRender } from './routes/render.js';
import { registerHealth, type HealthState } from './routes/health.js';
import type { ServerBackend } from './backend.js';

export interface BuiltServer {
  app: FastifyInstance;
  backend: ServerBackend;
  config: ServerConfig;
  health: HealthState;
}

/**
 * Compose the backend once and mount routes. With `renderPages > 0` one warm
 * `Renderer` instance — Chromium, page pool, resolver — backs every route; with 0 a bare resolver
 * serves the browserless routes and `POST /render` is absent. Boot-time failures propagate
 * (fail fast).
 */
export async function buildServer(overrides: Partial<ServerConfig> = {}): Promise<BuiltServer> {
  const config = { ...loadConfig(), ...overrides };
  const renderEnabled = config.renderPages > 0;

  if (renderEnabled && !config.chromiumPath) {
    throw new Error('CHROMIUM_PATH is required when rendering is enabled.');
  }

  const diagrams = renderEnabled
    ? await createRenderer({
        library: stockLibrary,
        chromiumPath: config.chromiumPath!,
        iconLoader: createEraserIconLoader(),
        ...(config.fonts ? { fonts: config.fonts } : {}),
        pages: config.renderPages,
      })
    : undefined;

  // Browserless mode still stages fonts so /health reports degraded families.
  const staged = !diagrams && config.fonts ? await stageFonts(config.fonts) : undefined;
  const backend: ServerBackend =
    diagrams ??
    (await createResolver({
      library: stockLibrary,
      iconLoader: createEraserIconLoader(),
    }));

  const app = Fastify({
    bodyLimit: config.bodyLimit,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Never log request bodies; request-id is Fastify's default reqId.
  });

  // Map transport-level failures onto the contract error envelope.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 413) {
      return reply.code(413).send({
        ok: false,
        errors: [
          {
            code: ERROR_CODE.PAYLOAD_TOO_LARGE,
            severity: SEVERITY.ERROR,
            path: '/',
            message: 'Request body is too large.',
          },
        ],
        warnings: [],
      });
    }

    // Malformed JSON and other client errors.
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;

    return reply.code(status).send({
      ok: false,
      errors: [
        {
          code: ERROR_CODE.BAD_JSON,
          severity: SEVERITY.ERROR,
          path: '/',
          message: 'Request body is not valid JSON.',
        },
      ],
      warnings: [],
    });
  });

  const health: HealthState = {
    ready: false,
    startedAt: performance.now(),
    degraded: diagrams?.degradedFonts ?? staged?.degraded ?? [],
    render: renderEnabled,
  };

  registerValidate(app, backend);
  registerRegistry(app, backend);
  registerHealth(app, health);

  if (diagrams) {
    registerRender(app, diagrams, {
      poolSize: config.renderPages,
      queueLimit: config.renderQueue,
    });
    app.addHook('onClose', () => diagrams.close());
  }

  // The backend is warm by the time buildServer resolves, so mark ready.
  health.ready = true;

  return { app, backend, config, health };
}
