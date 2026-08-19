import type { FastifyInstance } from 'fastify';

export interface HealthState {
  ready: boolean;
  startedAt: number;
  degraded: string[];
  /** Whether a warm browser pool serves `POST /render`. */
  render: boolean;
}

/** `GET /health` — 503 until warm, then 200 with uptime and degraded state. */
export function registerHealth(app: FastifyInstance, state: HealthState): void {
  app.get('/health', (_request, reply) => {
    if (!state.ready) {
      return reply.code(503).send({ status: 'starting' });
    }

    return reply.code(200).send({
      status: state.degraded.length > 0 ? 'degraded' : 'ok',
      uptimeMs: Math.round(performance.now() - state.startedAt),
      degraded: state.degraded,
      render: state.render,
    });
  });
}
