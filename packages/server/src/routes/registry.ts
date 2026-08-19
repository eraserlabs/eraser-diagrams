import type { FastifyInstance } from 'fastify';
import { ERROR_CODE, SEVERITY } from '@eraserlabs/resolve';
import type { ServerBackend } from '../backend.js';

/** `GET /registry` and `GET /registry/schema/:tag` — LLM tool discovery. */
export function registerRegistry(app: FastifyInstance, backend: ServerBackend): void {
  app.get('/registry', (_request, reply) => {
    return reply.code(200).send(backend.registryInfo());
  });

  app.get<{ Params: { tag: string } }>('/registry/schema/:tag', (request, reply) => {
    const schema = backend.tagSchema(request.params.tag);

    if (schema === undefined) {
      return reply.code(404).send({
        ok: false,
        errors: [
          {
            code: ERROR_CODE.UNKNOWN_TAG,
            severity: SEVERITY.ERROR,
            path: '/',
            message: `Unknown tag "${request.params.tag}".`,
          },
        ],
        warnings: [],
      });
    }

    return reply.code(200).send(schema);
  });
}
