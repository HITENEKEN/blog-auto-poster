/**
 * 발행 금지 문구의 **단일 출처** (스킬 §6 / 설계 §3-6·§5-4).
 *
 * 이 표가 코드에 존재하는 유일한 사본이다 — 초안 편집 게이트(`checkEditedDraft`)와
 * 광고 게이트(`checkAdGate` FORBIDDEN_TEXT)가 같은 규칙을 봐야 한쪽만 통과하는
 * 초안이 생기지 않는다. 규칙을 바꾸면 스킬 §6 표도 함께 고친다.
 *
 * 스코프가 둘로 나뉘는 이유: 자동 광고 문구·상품명은 **판매자가 지은 값**이라
 * 가격 단정 표현("100% 정품 보장")이 정당하게 들어간다. 초안 본문은 우리가 쓴
 * 문장이므로 가격 단정까지 막는다.
 */

/** 코드 + 정규식 한 줄. 코드는 로봇 메시지·테스트가 참조하므로 이름을 바꾸지 않는다. */
export interface ForbiddenTextRule {
  code: string;
  re: RegExp;
}

/**
 * 금지 문구 규칙 표(표 순서 = 코드 순서).
 *
 * - `FIRST_PERSON`: 1인칭 체험 화법 — 템플릿 기본 도입부가 만들므로 편집 단계에서 지운다.
 * - `STUB_TEXT`: 미구현 스텁 문구.
 * - `PLACEHOLDER`: 자리표시자(이미지 슬롯·TODO·Lorem ipsum).
 * - `UNSUPPORTED_PRICE`: 근거 없는 가격·정품 단정.
 *
 * 정규식에 `g` 플래그를 쓰지 않는다 — `test()`가 상태를 들고 다니면 같은 규칙이
 * 호출 순서에 따라 다르게 판정된다.
 */
export const FORBIDDEN_TEXT_RULES: ReadonlyArray<ForbiddenTextRule> = [
  {
    code: 'FIRST_PERSON',
    re: /제가|저는|저희|내돈내산|써봤|입어봤|신어봤|사용해\s*봤|직접\s*(?:써|사용|입어|구매|착용)/,
  },
  { code: 'STUB_TEXT', re: /향후\s*구현|구현\s*예정|coming\s+soon|준비\s*중입니다/i },
  { code: 'PLACEHOLDER', re: /⟦IMG\d+⟧|TODO|FIXME|Lorem\s+ipsum|placeholder/i },
  { code: 'UNSUPPORTED_PRICE', re: /최저가\s*보장|무조건\s*최저|가격\s*보장|100%\s*정품\s*보장/ },
];

export const FORBIDDEN_TEXT_CODES: ReadonlyArray<string> = FORBIDDEN_TEXT_RULES.map(
  (rule) => rule.code,
);

/** 초안 본문 스코프 — 모든 규칙. 로봇 `checkEditedDraft`가 쓴다. */
export const DRAFT_TEXT_CODES: ReadonlyArray<string> = FORBIDDEN_TEXT_CODES;

/**
 * 자동 광고 문구·상품명 스코프 — `UNSUPPORTED_PRICE` 제외.
 *
 * 판매자 상품명에는 "[100% 정품 보장]", "최저가 보장" 같은 표현이 흔하다.
 * 이 규칙을 광고 문구에 적용하면 정당한 소재가 발행 게이트에서 통째로 막힌다.
 * 가격 단정을 막아야 하는 대상은 우리가 쓴 초안 본문이다(그래서 DRAFT 스코프에는 남는다).
 */
export const AD_TEXT_CODES: ReadonlyArray<string> = FORBIDDEN_TEXT_CODES.filter(
  (code) => code !== 'UNSUPPORTED_PRICE',
);

/** 코드 부분집합에 해당하는 규칙(표 순서 유지). */
export function forbiddenTextRules(
  codes: ReadonlyArray<string> = FORBIDDEN_TEXT_CODES,
): ReadonlyArray<ForbiddenTextRule> {
  return FORBIDDEN_TEXT_RULES.filter((rule) => codes.includes(rule.code));
}

/** 규칙 목록으로 직접 스캔한다(호출부가 자체 RegExp[]를 넘길 때). */
export function findForbiddenTextRule(
  text: string,
  rules: ReadonlyArray<ForbiddenTextRule> = FORBIDDEN_TEXT_RULES,
): ForbiddenTextRule | null {
  const body = text ?? '';
  return rules.find((rule) => rule.re.test(body)) ?? null;
}

/** 일치한 금지 규칙 코드(중복 없이, 표 순서 유지). */
export function findForbiddenTextCodes(
  text: string,
  codes: ReadonlyArray<string> = FORBIDDEN_TEXT_CODES,
): string[] {
  const body = text ?? '';
  return forbiddenTextRules(codes)
    .filter((rule) => rule.re.test(body))
    .map((rule) => rule.code);
}

/** 금지 문구가 하나라도 있으면 true. */
export function matchesForbiddenText(
  text: string,
  codes: ReadonlyArray<string> = FORBIDDEN_TEXT_CODES,
): boolean {
  return findForbiddenTextRule(text ?? '', forbiddenTextRules(codes)) !== null;
}
