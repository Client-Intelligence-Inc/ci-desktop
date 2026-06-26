export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(204);
    }

    if (request.method !== 'POST') {
      return corsResponse(405, { error: 'Method not allowed' });
    }

    try {
      const body = await request.json();
      const { anonymousId, events } = body;

      if (!anonymousId || !Array.isArray(events) || events.length === 0) {
        return corsResponse(400, { error: 'Invalid payload' });
      }

      if (events.length > 200) {
        return corsResponse(400, { error: 'Too many events (max 200)' });
      }

      const stmt = env.DB.prepare(
        `INSERT INTO events (anonymous_id, event, properties, session_id, app_version, platform, arch, event_timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const batch = events.map((e) =>
        stmt.bind(
          anonymousId,
          e.event || 'unknown',
          e.properties ? JSON.stringify(e.properties) : null,
          e.sessionId || null,
          e.appVersion || null,
          e.platform || null,
          e.arch || null,
          e.timestamp || new Date().toISOString()
        )
      );

      await env.DB.batch(batch);

      return corsResponse(200, { ok: true, count: events.length });
    } catch (err) {
      return corsResponse(500, { error: 'Internal error' });
    }
  },
};

function corsResponse(status, body) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}
