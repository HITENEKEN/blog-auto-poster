/* eslint-disable no-console -- 진단용 CLI 스모크 스크립트 */
// 실-API 스모크(이슈 #14) — 데이터랩 분야 인기검색어 랭킹 직조회 동작 확인.
// 공식 쇼핑인사이트 API 키가 필요 없다(웹 UI 내부 XHR API, 로그인 불필요).
// usage: node -r ./scripts/path-alias.js scripts/smoke-datalab-rank.mjs [cat_id] [timeUnit] [count]
import { fetchDatalabCategoryKeywordRank } from '../dist/intelligence/DatalabShoppingRank.js';

const catId = process.argv[2] || '50000809'; // 패션의류 > 여성의류 > 청바지
const timeUnit = process.argv[3] || 'month';
const count = Number(process.argv[4] || 20);

// 최근 6개월(월간) / 최근 30일(그 외)
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const end = fmt(new Date(now.getTime() - 24 * 60 * 60 * 1000));
const start =
  timeUnit === 'month'
    ? fmt(new Date(now.getTime() - 182 * 24 * 60 * 60 * 1000))
    : fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

const t0 = Date.now();
const rows = await fetchDatalabCategoryKeywordRank({
  catId,
  startDate: start,
  endDate: end,
  timeUnit,
  count,
});
console.log(
  `[smoke] ${catId} ${start}~${end} ${timeUnit} — ${Date.now() - t0}ms, rows=${rows.length}`,
);
for (const r of rows) console.log(`  ${String(r.rank).padStart(3)}  ${r.keyword}`);
process.exit(0);
