#!/usr/bin/env node
/* eslint-disable no-console -- 코드표 생성 CLI 스크립트 */
/**
 * 네이버 쇼핑 카테고리 트리 스크래퍼 — src/web/shared/shoppingCategories.json 생성/갱신.
 *
 * 배경: SHPP_INST(쇼핑인사이트)에는 카테고리 목록 엔드포인트가 없어(공식문서도
 * cat_id 수기 확인 안내) 쇼핑 서비스의 공개 카테고리 트리를 1회 스크래핑해 정적
 * JSON으로 등록한다. 실행은 코드표 갱신 시 수동:
 *
 *   node scripts/scrape-naver-shopping-categories.mjs
 *   node scripts/scrape-naver-shopping-categories.mjs --probe   # 기존 JSON 유효성만 검증
 *
 * 두 모드 모두 인증 없이 동작한다(--probe만 config/development.yaml의
 * naver-api-hub 키를 읽어 SHPP /categories로 data 유무를 확인).
 *
 * 참고(2026-08 실측): shopping.naver.com 전면이 미인증 트래픽을 nid.naver.com
 * 로그인 페이지로 307 리다이렉트한다(데이터센터 IP 기준). 이 경우 스크립트는
 * 실패로 종료하고, 기존 JSON(사용자 제공 코드표 2026-08 — 대분류 8종, SHPP probe로
 * 검증)을 유지한다. 로그인 세션 쿠키를 환경변수 NS_COOKIE로 주입하면 우회할 수 있다.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/web/shared/shoppingCategories.json');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** JSON 트리에서 cat_id 수집 (중복 검사용). */
function collectIds(nodes, acc = new Set()) {
  for (const n of nodes) {
    if (acc.has(n.catId)) throw new Error(`duplicate catId: ${n.catId}`);
    acc.add(n.catId);
    if (n.children) collectIds(n.children, acc);
  }
  return acc;
}

/** 데이터랩 쇼핑인사이트 실측 대분류 12종(2026-08, 1~3분류 재귀 수집 + SHPP probe 검증).
 *  코드표 갱신 시 이 순서를 유지한다. */
function assertKnownCodes(nodes) {
  const known = [
    ['50000000', '패션의류'],
    ['50000001', '패션잡화'],
    ['50000002', '화장품/미용'],
    ['50000003', '디지털/가전'],
    ['50000004', '가구/인테리어'],
    ['50000005', '출산/육아'],
    ['50000006', '식품'],
    ['50000007', '스포츠/레저'],
    ['50000008', '생활/건강'],
    ['50000009', '여가/생활편의'],
    ['50000010', '면세점'],
    ['50005542', '도서'],
  ];
  if (nodes.length !== known.length) {
    throw new Error(`대분류 개수 불일치: ${nodes.length} != ${known.length}`);
  }
  known.forEach(([id, name], i) => {
    const hit = nodes[i];
    if (hit.catId !== id) throw new Error(`필수 대분류 누락/순서 불일치: ${id} != ${hit.catId}`);
    if (hit.name !== name) throw new Error(`필수 대분류 이름 불일치: ${id} ${hit.name} != ${name}`);
  });
}

/** 홈 페이지에서 카테고리 메뉴 추출 — 페이지 구조 변경 시 여기서 실패한다. */
async function scrapeLive() {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' };
  if (process.env.NS_COOKIE) headers.Cookie = process.env.NS_COOKIE;

  const res = await fetch('https://shopping.naver.com/ns/home', { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (html.length < 10000 || /nidlogin\.login/.test(html)) {
    throw new Error('봇 방어(로그인 리다이렉트)로 실 페이지를 받지 못했다');
  }

  // 대분류 메뉴: `N=a:ctg*l.<catId>` 직후 <em>라벨</em> (2020 실측 포맷)
  const pairs = [...html.matchAll(/ctg\*l\.(\d{8})[\s\S]{0,200}?<em>([^<]+)<\/em>/g)].map((m) => ({
    catId: m[1],
    name: m[2].trim(),
  }));
  if (pairs.length === 0)
    throw new Error('홈 HTML에서 카테고리 메뉴를 찾지 못했다 (구조 변경 추정)');
  return pairs;
}

/** config yaml에서 naver-api-hub 키 읽기 (정규식 기반, 의존성 없음). */
function readHubCredentials() {
  try {
    const yaml = readFileSync(resolve(ROOT, 'config/development.yaml'), 'utf8');
    const seg = yaml.split('naver-api-hub:')[1] ?? '';
    const apiKey = seg.match(/apiKey:\s*['"]?([^'"\s]+)/)?.[1];
    const apiSecret = seg.match(/apiSecret:\s*['"]?([^'"\s]+)/)?.[1];
    if (apiKey && apiSecret) return { apiKey, apiSecret };
  } catch {
    /* config 부재 시 probe 불가 */
  }
  return null;
}

/** SHPP /categories probe — 유효 cat_id는 time-series data가 존재한다. */
async function probeHasData(cred, catId) {
  const body = {
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    timeUnit: 'month',
    category: [{ name: 'probe', param: [catId] }],
  };
  const res = await fetch('https://naverapihub.apigw.ntruss.com/shopping/v1/categories', {
    method: 'POST',
    headers: {
      'X-NCP-APIGW-API-KEY-ID': cred.apiKey,
      'X-NCP-APIGW-API-KEY': cred.apiSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SHPP probe HTTP ${res.status} (${catId})`);
  const json = await res.json();
  return (json.results?.[0]?.data ?? []).length > 0;
}

async function main() {
  const existing = JSON.parse(readFileSync(OUT, 'utf8'));

  if (process.argv.includes('--probe')) {
    const cred = readHubCredentials();
    if (!cred)
      throw new Error('probe 모드는 config/development.yaml의 naver-api-hub 키가 필요하다');
    collectIds(existing);
    assertKnownCodes(existing);
    for (const n of existing) {
      const ok = await probeHasData(cred, n.catId);
      console.log(`${n.catId} ${n.name}: ${ok ? 'OK (data 존재)' : 'INVALID (data 없음)'}`);
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  const majors = await scrapeLive();
  collectIds(majors);
  assertKnownCodes([
    ...existing.filter((n) => !majors.some((m) => m.catId === n.catId)),
    ...majors,
  ]);
  writeFileSync(OUT, JSON.stringify(majors, null, 2) + '\n');
  console.log(`wrote ${majors.length} categories -> ${OUT}`);
}

main().catch((err) => {
  console.error(`[scrape-naver-shopping-categories] 실패: ${err.message}`);
  console.error('기존 JSON을 유지한다. 로그인 세션(NS_COOKIE) 주입 또는 수기 갱신 후 재실행.');
  process.exitCode = 1;
});
