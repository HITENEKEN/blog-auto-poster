// Naver API Hub mock server — zero dependencies (node:http only).
// Mirrors NaverApiSearchResponse / NaverApiBlogItem / NaverApiNewsItem from
// src/intelligence/NaverApiHubProvider.ts:15-42. The `title` field echoes the
// incoming query so tests can assert the request actually reached this mock.
import http from 'node:http';

const PORT = parseInt(process.env.MOCK_PORT || '4600', 10);
const HOST = '127.0.0.1';

function logRequest(method, url) {
  console.log(`[naver-hub-mock] ${method} ${url}`);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getQuery(url) {
  try {
    const parsed = new URL(url, `http://${HOST}:${PORT}`);
    return parsed.searchParams.get('query') ?? parsed.searchParams.get('q') ?? '';
  } catch {
    return '';
  }
}

function blogItems(query, count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      title: `[mock] ${query} 블로그 ${n}`,
      link: `https://mock.blog.example/${encodeURIComponent(query)}/${n}`,
      description: `[mock] description for ${query} (${n})`,
      bloggername: `mock-blogger-${n}`,
      bloggerlink: `https://mock.blogger.example/${n}`,
      postdate: '20260828',
    };
  });
}

const server = http.createServer((req, res) => {
  logRequest(req.method, req.url);

  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/blog') {
    const query = getQuery(req.url);
    const items = blogItems(query, 3);
    sendJson(res, 200, { total: 3, start: 1, display: 3, items });
    return;
  }

  if (pathname === '/news') {
    const query = getQuery(req.url);
    sendJson(res, 200, {
      total: 1,
      start: 1,
      display: 1,
      items: [
        {
          title: `[mock] ${query} 뉴스 1`,
          link: 'https://mock.news.example/1',
          description: `[mock] news description for ${query}`,
          pubDate: 'Fri, 28 Aug 2026 00:00:00 +0900',
        },
      ],
    });
    return;
  }

  if (pathname === '/health' || pathname === '/healthz') {
    sendJson(res, 200, 'ok');
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[naver-hub-mock] listening on http://${HOST}:${PORT}`);
});
