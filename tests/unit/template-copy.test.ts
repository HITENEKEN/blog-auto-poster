import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_TEXT_CODES,
  findForbiddenTextCodes,
  FORBIDDEN_TEXT_RULES,
} from '../../src/content/ForbiddenText';

/**
 * 템플릿 정적 카피의 정직성 회귀 가드 (스킬 §6 / 계획 §4-3).
 *
 * 템플릿 기본값이 1인칭 체험담("저도 처음 … 직접 비교해 보니", "제가 직접 써본")을
 * 만들면, 매 사이클 로봇의 EDIT 게이트가 그 문장을 지워야만 발행할 수 있다 —
 * LLM이 지워 주기를 기대하는 구조를 만들지 않는다(계획 §4-3).
 *
 * 검사 대상은 **가공하지 않은 .hbs 원문**이다. 주석·frontmatter 포함해서 스캔하므로
 * 화면에 안 보이는 문장으로도 규칙이 슬며시 돌아올 수 없다.
 * `{{experienceIntro}}`처럼 LLM이 채우는 플레이스홀더는 값이 아니라 이름만 있으므로
 * 통과한다(정적 카피만 검사한다).
 */
const templatesDir = fileURLToPath(new URL('../../templates', import.meta.url));
const templateFiles = readdirSync(templatesDir).filter((file) => file.endsWith('.hbs'));

describe('templates/*.hbs — 정적 카피에 금지 문구가 없다', () => {
  it('템플릿 6종을 모두 검사한다', () => {
    expect(templateFiles).toHaveLength(6);
  });

  it('원문 텍스트가 FIRST_PERSON/STUB_TEXT/PLACEHOLDER/UNSUPPORTED_PRICE에 걸리지 않는다', () => {
    const offenders: string[] = [];
    for (const file of templateFiles) {
      const raw = readFileSync(`${templatesDir}/${file}`, 'utf8');
      const codes = findForbiddenTextCodes(raw, DRAFT_TEXT_CODES);
      if (codes.length > 0) {
        const rule = FORBIDDEN_TEXT_RULES.find((entry) => codes.includes(entry.code));
        const sample = rule ? (rule.re.exec(raw)?.[0] ?? '') : '';
        offenders.push(`${file}: ${codes.join(',')} (“${sample}”)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('검사가 실제로 잡아낸다 — 예전 템플릿 문장은 위반으로 판정된다', () => {
    // 가드가 무력화(정규식 완화·검사 대상 축소)되면 이 케이스가 먼저 깨진다.
    // 아래 두 문장은 실제로 템플릿에서 제거한 정적 카피다.
    expect(findForbiddenTextCodes('<h2>제가 직접 써본 상세 후기</h2>', DRAFT_TEXT_CODES)).toEqual([
      'FIRST_PERSON',
    ]);
    expect(
      findForbiddenTextCodes(
        '<div>저도 처음 살 때는 막막했는데, 제가 겪어보고 정리한 기준입니다.</div>',
        DRAFT_TEXT_CODES,
      ),
    ).toEqual(['FIRST_PERSON']);
    expect(findForbiddenTextCodes('최저가 보장 상품', DRAFT_TEXT_CODES)).toEqual([
      'UNSUPPORTED_PRICE',
    ]);
  });
});
