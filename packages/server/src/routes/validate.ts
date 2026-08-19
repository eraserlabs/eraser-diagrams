import type { FastifyInstance } from 'fastify';
import type { ServerBackend } from '../backend.js';

/** `POST /validate` — always 200 JSON. A cheap pre-check for callers. */
export function registerValidate(app: FastifyInstance, backend: ServerBackend): void {
  app.post('/validate', async (request, reply) => {
    const result = await backend.validate(request.body);

    return reply.code(200).send(result);
  });
}
