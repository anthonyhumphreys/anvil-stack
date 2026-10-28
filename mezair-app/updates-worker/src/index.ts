import { handleRequest } from './handler.js';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: 'desktop_update_request_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json(
        { error: 'Update service unavailable.' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '60',
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
