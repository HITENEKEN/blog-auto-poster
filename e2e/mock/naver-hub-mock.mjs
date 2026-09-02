/* eslint-disable no-console -- stdout request logging is this script's purpose */
// Naver API Hub mock server — zero dependencies (node:http only).
// Mirrors NaverApiSearchResponse / NaverApiBlogItem / NaverApiNewsItem from
// src/intelligence/NaverApiHubProvider.ts:15-42. The `title` field echoes the
// incoming query so tests can assert the request actually reached this mock.
import http from 'node:http';

const PORT = parseInt(process.env.MOCK_PORT || '4600', 10);
const HOST = '127.0.0.1';

function logRequest(method, url, body) {
  // POST는 요청 바디(카테고리/키워드)를 함께 기록한다 — 카테고리별 outbound
  // body 차이를 로그로 단언할 수 있어야 한다.
  const bodyPart = body ? ` body=${body}` : '';
  console.log(`[naver-hub-mock] ${method} ${url}${bodyPart}`);
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
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const TREND_DATA = [
  ...['09', '10', '11', '12'].map((m) => ({ period: `2025-${m}-01`, ratio: 10 })),
  ...['01', '02', '03', '04', '05'].map((m) => ({ period: `2026-${m}-01`, ratio: 10 })),
  { period: '2026-06-01', ratio: 50 },
  { period: '2026-07-01', ratio: 75 },
  { period: '2026-08-01', ratio: 100 },
];

// 분야-level breakdown 그룹 구성 (실-API 프로브 확정: data 포인트 내부 group 필드).
const BREAKDOWN_GROUPS = {
  '/shopping/v1/category/device': {
    groups: ['mo', 'pc'],
    weights: { mo: 1, pc: 0.6 },
  },
  '/shopping/v1/category/gender': {
    groups: ['f', 'm'],
    weights: { f: 1, m: 0.8 },
  },
  '/shopping/v1/category/age': {
    groups: ['10', '20', '30', '40', '50', '60'],
    weights: { 10: 0.4, 20: 1, 30: 0.9, 40: 0.7, 50: 0.5, 60: 0.3 },
  },
};

async function handlePost(req, res, pathname) {
  // 데이터랩 분야 인기검색어 랭킹(이슈 #14) — 내부 XHR API(form-urlencoded POST,
  // JSON body 아님)이므로 body 파싱 전에 고정 응답을 반환한다.
  if (pathname === '/shoppingInsight/getCategoryKeywordRank.naver') {
    logRequest('POST', `${pathname} (form-urlencoded)`);
    sendJson(res, 200, {
      message: null,
      statusCode: 200,
      returnCode: 0,
      range: '2026.08.01. ~ 2026.08.31.',
      ranks: [
        { rank: 1, keyword: '여자 원피스', linkId: '여자 원피스' },
        { rank: 2, keyword: '블라우스', linkId: '블라우스' },
        { rank: 3, keyword: '니트', linkId: '니트' },
      ],
    });
    return;
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    body = {};
  }
  logRequest('POST', `${pathname} body=${JSON.stringify(body)}`);
  if (pathname === '/search-trend/v1/search') {
    const groups = Array.isArray(body.keywordGroups) ? body.keywordGroups : [];
    sendJson(res, 200, {
      startDate: body.startDate ?? '2025-09-01',
      endDate: body.endDate ?? '2026-08-31',
      timeUnit: body.timeUnit ?? 'month',
      results: groups.map((g) => ({ title: g.groupName, keywords: g.keywords, data: TREND_DATA })),
    });
    return;
  }

  if (pathname === '/shopping/v1/category/keywords') {
    const pairs = Array.isArray(body.keyword) ? body.keyword : [];
    // R5 빈-data 폴백 테스트용 allowlist — 소속 키워드만 data를 채우고 나머지는
    // 실-API와 동일하게 data:[]로 응답한다(그룹 entry 자체는 유지).
    const CATEGORY_ALLOWLIST = new Set(['여자 원피스']);
    sendJson(res, 200, {
      startDate: body.startDate ?? '2025-09-01',
      endDate: body.endDate ?? '2026-08-31',
      timeUnit: body.timeUnit ?? 'month',
      results: pairs.map((p) => ({
        title: p.name,
        keyword: p.param,
        data: CATEGORY_ALLOWLIST.has(p.name) ? TREND_DATA : [],
      })),
    });
    return;
  }

  // 분야-level breakdown (/category/device|gender|age) — 실-API는 단일 results
  // entry 안의 data[] 포인트에 group 필드('mo'|'pc', 'f'|'m', '10'..'60')가 들어간다.
  // 그룹별 계수를 곱해 기간 합이 그룹마다 다르게 한다(R4 비중 파이 검증용).
  if (pathname in BREAKDOWN_GROUPS) {
    const { groups, weights } = BREAKDOWN_GROUPS[pathname];
    const cat = Array.isArray(body.category) ? body.category[0]?.name : body.category;
    sendJson(res, 200, {
      startDate: body.startDate ?? '2025-09-01',
      endDate: body.endDate ?? '2026-08-31',
      timeUnit: body.timeUnit ?? 'month',
      results: [
        {
          title: cat || 'mock-category',
          data: groups.flatMap((g) =>
            TREND_DATA.map((p) => ({
              ...p,
              ratio: Math.round(p.ratio * weights[g] * 10) / 10,
              group: g,
            })),
          ),
        },
      ],
    });
    return;
  }

  // 나머지 /shopping/v1/... 공식 경로 공용 핸들러 — 요청을 echo해 테스트가
  // 도달을 단언할 수 있도록 title에 keyword/category를 반영한다.
  // /categories는 category가 [{name, param}] 배열, keyword-level breakdown은
  // keyword가 String. /category/keywords와 분야-level breakdown
  // (/category/device|gender|age)은 위 전용 핸들러가 담당한다.
  if (pathname.startsWith('/shopping/v1/')) {
    const kw = body.keyword;
    const cat = Array.isArray(body.category) ? body.category[0]?.name : body.category;
    const title = (Array.isArray(kw) ? kw[0]?.name : (kw?.name ?? kw)) || cat || 'mock-category';
    sendJson(res, 200, {
      startDate: body.startDate ?? '2025-09-01',
      endDate: body.endDate ?? '2026-08-31',
      timeUnit: body.timeUnit ?? 'month',
      results: [{ title, data: TREND_DATA }],
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (req.method !== 'POST') logRequest(req.method, req.url);
  if (req.method === 'POST') {
    await handlePost(req, res, pathname);
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

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
