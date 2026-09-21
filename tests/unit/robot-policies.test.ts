import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TEXT_CODES, forbiddenTextRules } from '../../src/content/ForbiddenText';
import {
  MAX_BLOCKS_HARD_CAP,
  SESSION_MIN_DAYS,
  WEEKLY_HARD_CAP,
  bodyTextLength,
  checkEditedDraft,
  dropPartialWeek,
  filterCandidates,
  findForbiddenPatterns,
  isConsecutiveCategory,
  isDemandOk,
  isDuplicate,
  isSaturationOk,
  isWeeklyCapReached,
  medianBlogsSim,
  normalizeKeyword,
  rankTopics,
  validateRobotConfig,
  weeklyPublishedCount,
  type TopicCandidate,
} from '../../src/robot/policies';
import { ROBOT_CONFIG_DEFAULTS } from '../../src/robot/config';

/** 스킬 §5·§6·§11 규칙의 코드화 검증. */

const WEEK = (ratios: number[]) =>
  ratios.map((ratio, i) => ({ period: `2026-W${String(i + 1).padStart(2, '0')}`, ratio }));

/** 실제 API 응답 모양: 마지막 주(2026-09-14)가 부분 집계로 급락한 시계열. */
function WEEK_INCOMPLETE() {
  return [
    { period: '2026-08-17', ratio: 84.1 },
    { period: '2026-08-24', ratio: 87.27 },
    { period: '2026-08-31', ratio: 85.44 },
    { period: '2026-09-07', ratio: 81.59 },
    { period: '2026-09-14', ratio: 21.34 },
  ];
}

function candidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    keyword: '트위드자켓',
    categoryId: '50000000',
    series: WEEK([50, 55, 60, 65, 70, 72, 74, 76]),
    categorySeries: WEEK([50, 52, 55, 58, 60, 62, 64, 66]),
    blogs: { sim: 100, date: 200 },
    adCount: 2,
    ...overrides,
  };
}

describe('policies — 수요·포화', () => {
  it('isDemandOk: 상승·견조는 통과, 하락은 탈락', () => {
    expect(isDemandOk(WEEK([50, 55, 60, 65, 70, 75, 80, 85]))).toBe(true);
    expect(isDemandOk(WEEK([100, 100, 100, 100, 50, 40, 30, 20]))).toBe(false); // falling(-70%)
    expect(isDemandOk([])).toBe(false);
  });

  it('isDemandOk: 마지막 값이 최근 4주 최댓값의 80% 미만이면 탈락', () => {
    // 최근 4주 [50, 100, 60, 40] → peak 100, last 40 < 80
    expect(isDemandOk(WEEK([10, 20, 30, 40, 50, 100, 60, 40]))).toBe(false);
    // 최근 4주 [50, 100, 90, 85] → peak 100, last 85 ≥ 80
    expect(isDemandOk(WEEK([10, 20, 30, 40, 50, 100, 90, 85]))).toBe(true);
  });

  it('isSaturationOk: 후보 전체 중앙값 이하만 통과', () => {
    expect(medianBlogsSim([100, 200, 300])).toBe(200);
    expect(medianBlogsSim([100, 200, 300, 400])).toBe(250);
    expect(medianBlogsSim([])).toBe(0);
    expect(isSaturationOk(200, [100, 200, 300])).toBe(true);
    expect(isSaturationOk(300, [100, 200, 300])).toBe(false);
  });
});

describe('policies — 중복·연속 카테고리', () => {
  const now = new Date('2026-09-22T21:10:00+09:00');

  it('정규화: 공백·특수문자·대소문자를 무시한다', () => {
    expect(normalizeKeyword('트위드 자켓')).toBe(normalizeKeyword('트위드자켓'));
    expect(normalizeKeyword('Tweed-Jacket!')).toBe('tweedjacket');
  });

  it('180일 윈도우 안의 같은 주제는 중복, 밖이면 아니다', () => {
    const titles = [
      { title: '트위드 자켓 고르는 기준', pubDate: new Date('2026-08-01T12:00:00+09:00') },
    ];
    expect(isDuplicate('트위드자켓', titles, 180, now)).toBe(true);
    expect(isDuplicate('울코트', titles, 180, now)).toBe(false);

    const old = [{ title: '트위드 자켓', pubDate: new Date('2025-01-01T12:00:00+09:00') }];
    expect(isDuplicate('트위드자켓', old, 180, now)).toBe(false);
  });

  it('계절 키워드는 365일 윈도우로 다시 검사한다', () => {
    const seasonal = [
      { title: '제습기 고르는 기준', pubDate: new Date('2026-03-01T12:00:00+09:00') },
    ];
    expect(isDuplicate('제습기', seasonal, 180, now)).toBe(false);
    expect(isDuplicate('제습기', seasonal, 365, now)).toBe(true);
  });

  it('pubDate가 없으면 보수적으로 중복으로 본다', () => {
    expect(isDuplicate('트위드자켓', [{ title: '트위드 자켓', pubDate: null }], 180, now)).toBe(
      true,
    );
  });

  it('isConsecutiveCategory: 직전 발행 카테고리와 같으면 탈락', () => {
    expect(isConsecutiveCategory('50000000', '50000000')).toBe(true);
    expect(isConsecutiveCategory('50000000', '50000001')).toBe(false);
    expect(isConsecutiveCategory(null, '50000000')).toBe(false);
  });
});

describe('policies — 주간 상한', () => {
  it('WEEKLY_HARD_CAP은 3이고 두 축 중 큰 값을 쓴다', () => {
    expect(WEEKLY_HARD_CAP).toBe(3);
    expect(weeklyPublishedCount(2, 0)).toBe(2);
    expect(weeklyPublishedCount(0, 3)).toBe(3);
    expect(isWeeklyCapReached(3, 0)).toBe(true);
    expect(isWeeklyCapReached(0, 3)).toBe(true);
    expect(isWeeklyCapReached(2, 2)).toBe(false);
  });
});

describe('policies — 금지 패턴', () => {
  it('1인칭 체험·스텁·자리표시자를 검출한다', () => {
    expect(findForbiddenPatterns('제가 직접 써봤습니다')).toContain('FIRST_PERSON');
    expect(findForbiddenPatterns('향후 구현 예정입니다')).toContain('STUB_TEXT');
    expect(findForbiddenPatterns('⟦IMG1⟧ 자리')).toContain('PLACEHOLDER');
    expect(findForbiddenPatterns('안감 있는 울 혼방을 고르세요')).toEqual([]);
  });

  it('금지 문구 표는 공용 단일 출처(@content/ForbiddenText)의 4개 코드다', () => {
    expect([...FORBIDDEN_TEXT_CODES].sort()).toEqual([
      'FIRST_PERSON',
      'PLACEHOLDER',
      'STUB_TEXT',
      'UNSUPPORTED_PRICE',
    ]);
    const firstPerson = forbiddenTextRules(['FIRST_PERSON']);
    expect(firstPerson).toHaveLength(1);
    expect(firstPerson[0].re.test('내돈내산 후기')).toBe(true);
  });
});

describe('policies — 주제 순위', () => {
  it('점수 = 최근 4주 평균 × 소재 가점 ÷ log10(blogs.sim + 10)', () => {
    const ranked = rankTopics([
      candidate({
        keyword: 'A',
        series: WEEK([10, 20, 30, 40, 40, 40, 40, 40]),
        adCount: 0,
        blogs: { sim: 0, date: 0 },
      }),
    ]);
    // 최근 4주 평균 40, 가점 없음, log10(10) = 1
    expect(ranked[0].score).toBe(40);
  });

  it('소재가 있으면 가점 0.3이 붙고, 동점이면 소재가 많은 쪽이 앞선다', () => {
    const withAds = rankTopics([
      candidate({
        keyword: 'A',
        adCount: 2,
        series: WEEK([40, 40, 40, 40]),
        blogs: { sim: 0, date: 0 },
      }),
    ]);
    const withoutAds = rankTopics([
      candidate({
        keyword: 'B',
        adCount: 0,
        series: WEEK([40, 40, 40, 40]),
        blogs: { sim: 0, date: 0 },
      }),
    ]);
    expect(withAds[0].score).toBeCloseTo(52, 1);
    expect(withoutAds[0].score).toBeCloseTo(40, 1);

    const tied = rankTopics([
      candidate({
        keyword: 'B',
        adCount: 0,
        series: WEEK([40, 40, 40, 40]),
        blogs: { sim: 0, date: 0 },
      }),
      candidate({
        keyword: 'A',
        adCount: 0,
        series: WEEK([40, 40, 40, 40]),
        blogs: { sim: 0, date: 0 },
      }),
    ]);
    expect(tied.map((r) => r.candidate.keyword)).toEqual(['A', 'B']); // 사전순
  });
});

describe('policies — 후보 필터', () => {
  it('탈락 사유를 남기고 통과 후보만 돌려준다', () => {
    const now = new Date('2026-09-22T21:10:00+09:00');
    const result = filterCandidates(
      [
        candidate({ keyword: '통과' }),
        candidate({ keyword: '하락', series: WEEK([90, 80, 70, 60, 50, 40, 30, 20]) }),
        candidate({ keyword: '포화', blogs: { sim: 9999, date: 1 } }),
        candidate({ keyword: '중복' }),
        candidate({ keyword: '연속', categoryId: '40000000' }),
      ],
      {
        now,
        live: [{ title: '중복 키워드 정리', pubDate: new Date('2026-09-01T00:00:00+09:00') }],
        previousCategoryId: '40000000',
      },
    );
    expect(result.pass.map((c) => c.keyword)).toEqual(['통과']);
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.keyword, r.reasons]));
    expect(reasons['하락']).toContain('demand');
    expect(reasons['포화']).toContain('saturation');
    expect(reasons['중복']).toContain('duplicate');
    expect(reasons['연속']).toContain('consecutive-category');
  });

  it('writable=false는 Judge 결과대로 제외한다', () => {
    const result = filterCandidates([candidate({ keyword: '경험필요', writable: false })], {
      live: [],
      now: new Date('2026-09-22T21:10:00+09:00'),
    });
    expect(result.pass).toHaveLength(0);
    expect(result.rejected[0].reasons).toContain('not-writable');
  });
});

describe('policies — 편집 게이트', () => {
  const original = [
    '<h2>1. 소재</h2><p>본문 텍스트입니다. 충분히 길게 씁니다.</p>',
    '<h2>2. 기준</h2><p>두 번째 섹션 본문입니다.</p>',
    '<a href="https://example.com/a">참고</a>',
    '<div data-coupang-widget="product-link"></div>',
  ].join('\n');

  it('구조가 그대로면 위반이 없다', () => {
    expect(checkEditedDraft(original, original)).toEqual([]);
  });

  it('h2 개수·이미지·링크·금지 문구·길이·위젯 마커를 검사한다', () => {
    const codes = (html: string) => checkEditedDraft(original, html).map((v) => v.code);

    expect(codes(original.replace('<h2>2. 기준</h2>', ''))).toContain('H2_COUNT');
    expect(
      codes(original.replace('<p>본문', '<img src="output/images/new.png"><p>본문')),
    ).toContain('IMAGE_ADDED');
    expect(
      codes(original.replace('<a href=', '<a href="https://spam.example.com" data-x="1" href=')),
    ).toContain('LINK_ADDED');
    expect(codes(original.replace('본문 텍스트입니다', '제가 직접 써봤습니다'))).toContain(
      'FORBIDDEN_TEXT',
    );
    expect(codes(original.replace('본문 텍스트입니다. 충분히 길게 씁니다.', '짧음'))).toContain(
      'TOO_SHORT',
    );
    expect(codes(original.replace('data-coupang-widget="product-link"', ''))).toContain(
      'WIDGET_MARKER',
    );
  });

  it('bodyTextLength는 태그를 제외한 공백 제거 길이', () => {
    expect(bodyTextLength('<p>가 나 다</p>')).toBe(3);
  });
});

describe('policies — 설정 검증(설계 §6)', () => {
  const base = {
    enabled: false,
    mode: 'manual' as const,
    categories: [] as string[],
    images: { review: 'human' as const },
    slots: ROBOT_CONFIG_DEFAULTS.slots,
    ads: ROBOT_CONFIG_DEFAULTS.ads,
  };

  it('기본값은 통과한다', () => {
    expect(validateRobotConfig(base)).toEqual([]);
  });

  it('mode=auto + images.review=human은 거부한다', () => {
    const errors = validateRobotConfig({ ...base, mode: 'auto' });
    expect(errors.join(' ')).toContain('images.review=human');
  });

  it('enabled=true + categories 비어 있으면 거부한다', () => {
    expect(validateRobotConfig({ ...base, enabled: true }).join(' ')).toContain('categories');
  });

  it('주간 발행 슬롯이 3회를 넘으면 거부한다', () => {
    const errors = validateRobotConfig({
      ...base,
      slots: {
        plan: base.slots.plan,
        publish: [
          ...base.slots.publish,
          { day: 'mon', time: '21:10' },
          { day: 'wed', time: '21:10' },
        ],
      },
    });
    expect(errors.join(' ')).toContain(`주간 상한 ${WEEKLY_HARD_CAP}`);
  });

  it('maxAds(블록 수) 하드 캡 초과는 거부한다', () => {
    const errors = validateRobotConfig({
      ...base,
      ads: { ...base.ads, maxBlocks: MAX_BLOCKS_HARD_CAP + 1, minBlocks: 1 },
    });
    expect(errors.join(' ')).toContain('하드 캡');
  });

  it('SESSION_MIN_DAYS는 14다', () => {
    expect(SESSION_MIN_DAYS).toBe(14);
  });
});

describe('policies — 진행 중인 주(부분 집계) 처리', () => {
  const now = new Date('2026-09-15T22:00:00+09:00'); // 화요일: 마지막 주는 월·화만 집계됨

  it('dropPartialWeek는 아직 끝나지 않은 마지막 주를 버린다', () => {
    const series = WEEK_INCOMPLETE();
    expect(dropPartialWeek(series, now)).toHaveLength(series.length - 1);
    // 완결된 주(과거)면 그대로 둔다
    const past = new Date('2026-10-05T12:00:00+09:00');
    expect(dropPartialWeek(series, past)).toHaveLength(series.length);
    expect(dropPartialWeek([], now)).toEqual([]);
  });

  it('부분 집계 주를 포함하면 견조한 키워드도 하락으로 보인다 — 완결 주로 비교한다', () => {
    const series = WEEK_INCOMPLETE();
    // 마지막(부분) 주 21.34 vs 최근 4주 최댓값 87.27 → 0.8 미만
    expect(isDemandOk(series)).toBe(false);
    // 완결 주만 보면 81.59 / 87.27 = 0.93 → 통과
    expect(isDemandOk(series, now)).toBe(true);
  });

  it('filterCandidates는 통과 후보의 시계열에서 부분 주를 제거해 순위 계산에 넘긴다', () => {
    const result = filterCandidates([candidate({ keyword: '견조', series: WEEK_INCOMPLETE() })], {
      live: [],
      now,
    });
    expect(result.pass).toHaveLength(1);
    expect(result.pass[0].series).toHaveLength(WEEK_INCOMPLETE().length - 1);
  });
});
