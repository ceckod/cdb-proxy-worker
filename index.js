export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('target');
    if (!target) {
      return new Response('Липсва ?target=...', {
        status: 400,
        headers: corsHeaders
      });
    }

    try {
      const r = await fetch(target, {
        method: request.method,
        headers: { 'User-Agent': 'Mozilla/5.0 (CD-B Dashboard proxy; +' + url.origin + ')' },
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
      });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: {
          ...corsHeaders,
          'Content-Type': r.headers.get('Content-Type') || 'text/plain; charset=utf-8'
        }
      });
    } catch (e) {
      return new Response('Proxy fetch грешка: ' + e.message, {
        status: 502,
        headers: corsHeaders
      });
    }
  }
};
