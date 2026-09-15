---
name: naver-blog-cycle
description: 네이버 블로그 주기 발행 1사이클(검색수요 조회 → 주제 선정 → 초안 생성·편집 → 공개 발행 → PC·모바일·비로그인 독자 검증)을 실행하거나 그 주기 운영을 점검할 때 사용한다. 발행은 비가역이므로 절차를 임의로 바꾸지 않는다.
---

# 네이버 블로그 발행 1사이클 (실행 계약)

이 파일은 **실행 규칙**이다. 설계 배경·근거는 `documents/22-naver-publish-runbook.md`(레포), 단계별 (a)/(b)/(c) 분류는 동일 문서 §2를 본다. 여기 있는 명령·게이트는 2026-09-14 실행 1건(logNo `224411764637`)과 그 실측 증거로 검증된 것만 담았다. **명령을 추측으로 바꾸지 마라.**

## 0. 적용 / 비적용

**적용**: 레포 `/Users/prily/Work/blog-auto-poster`에서 네이버 블로그(`hiteneken`)에 글 **1건**을 공개 발행하는 1사이클.

**비적용 (금지)**

| 금지                                                                | 이유                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1사이클에 2건 이상 발행                                             | 중복 발행 이력 실재(2026-09-03 동일 제목 4행/7분, 2026-09-08 4행)                                 |
| `config/default.yaml`의 스케줄러 활성화 / `scheduler.enabled: true` | 그 잡은 `platforms:['tistory']`, `maxPostsPerRun: 5` — 네이버 발행이 아니다                       |
| 타 플랫폼(tistory/wordpress/youtube-shorts) 활성화                  | `enabled:false` 유지가 계약. 발행 대상은 `platform:"naver"` 하나뿐                                |
| 게시물 삭제 (`DELETE /api/posts/:id`)                               | 로컬 행만 지워지고 네이버 원문은 남아 불일치만 커진다                                             |
| 발행물 수정 시도                                                    | 브라우저 발행 경로는 **생성 전용**이고 OpenAPI 수정 경로는 차단(051). 발행 후 결함은 고칠 수 없다 |
| `npm run naver:login` 자동 실행 / 자격증명 자동 입력                | 2FA는 헤드리스로 통과 불가. 로그인은 사람이 한다                                                  |
| 임의의 `curl`로 Naver postwrite 조작                                | 발행은 아래 S11의 API 1회 호출로만 한다                                                           |

## 1. 환경 고정

**셸 계약**: 아래 명령 블록은 **zsh/bash 기준**이다(POSIX `sh`는 아니다 — `comm -13 <(…)` 같은 프로세스 치환이 `syntax error near unexpected token '('`로 죽는 것을 실측 확인). 검증 환경: macOS 26 / zsh 5.9 / bash 3.2. 명령은 프로세스 치환 없이 파이프·리다이렉션·`$(...)`·중괄호 확장만 쓴다. launchd 트리거는 셸을 거치지 않고 `omp`를 직접 실행한다(`documents/22-naver-publish-runbook.md` §3).

```bash
set -o pipefail   # §9의 `| tee` 파이프에서도 하네스 종료 코드가 유지된다(zsh/bash 공통). 없으면 tee의 0이 실패를 덮는다
REPO=/Users/prily/Work/blog-auto-poster
BID=hiteneken                 # config platforms.naver.blogId
API=http://127.0.0.1:3002     # 운영 PM2 서버. dev(3005)는 쓰지 않는다
RUN_ID=$(date +%Y%m%dT%H%M%S)
cd "$REPO"
mkdir -p "data/ops/runs/$RUN_ID"/{live,keyword,draft,publish,verify}
```

## 2. S0 — 프리플라이트 (하나라도 어긋나면 중단)

```bash
# (1) 서버 상태: naver만 true, 스케줄러는 정지.
# 형태 주의: platforms/scheduler는 최상위가 아니라 services.* 아래에 중첩이다(2026-09-15 실측).
curl -s $API/health | jq -e '.services.platforms.naver == true and .services.platforms.tistory == false and .services.platforms.wordpress == false and .services.platforms["youtube-shorts"] == false and .services.scheduler == "stopped"' > /dev/null \
  || { echo "S0 실패: /health 불일치(서버 미기동·플랫폼 상태·스케줄러 중 하나)" >&2; exit 1; }

# (2) 네이버 세션 쿠키 만료 — 운영 프로필을 **읽기 전용**으로 직접 조회한다(복사하지 않는다: 로그인 쿠키를 /tmp에 남기지 않고 journal/WAL 상태도 그대로 본다)
sqlite3 -readonly "data/browser-profiles/naver/Default/Cookies" \
  "select name, datetime(expires_utc/1000000-11644473600,'unixepoch') from cookies where name in ('NID_AUT','NID_SES');"
# 실측(2026-09-15): NID_AUT|2027-10-19 13:15:24 / NID_SES|2026-10-14 13:42:58
# NID_AUT 없음 → 중단. 남은 기간 < 14일 → 중단하고 사람에게 "npm run naver:login 실행 필요" 요청

# (3) 이미지 예산 원장 (일일 20장) — 파일은 "마지막 생성일"의 기록이다
cat output/images/.image-usage.json
# date != 오늘이면 지난 날짜 기록이고 오늘 사용량은 0으로 시작한다(loadLedger가 날짜 변경 시 리셋 — src/content/ImageGenerator.ts:569-585).
# date == 오늘 && count >= 20 이면 중단(다음 날 실행).

# (4) 대시보드 API 토큰 — 값은 절대 출력하지 않는다
# 자격증명 해석: env BLOG_POSTER_WEB_ADMIN_USERNAME/PASSWORD → 없으면 미들웨어 기본값 admin/changeme.
# 실측(2026-09-15): 이 박스의 PM2 환경에는 두 변수가 없고 config web.auth.disabled=false라 기본값으로 로그인된다.
# (: "${VAR:=기본값}" — 미설정/빈 문자열이면 기본값을 채운다. 운영에서 기본값을 바꿨다면 env로 넘겨라.)
: "${BLOG_POSTER_WEB_ADMIN_USERNAME:=admin}"
: "${BLOG_POSTER_WEB_ADMIN_PASSWORD:=changeme}"
TOKEN=$(curl -s -X POST $API/api/auth/login -H 'content-type: application/json' \
  -d "{\"username\":\"$BLOG_POSTER_WEB_ADMIN_USERNAME\",\"password\":\"$BLOG_POSTER_WEB_ADMIN_PASSWORD\"}" \
  | jq -r .token)
# 401이면 .token이 null이 되고 이후 모든 호출이 조용히 401로 흐른다 — 여기서 끊는다.
case "$TOKEN" in ""|null) echo "S0 실패: 대시보드 로그인 실패 — BLOG_POSTER_WEB_ADMIN_* 확인 (src/web/server/middleware/auth.ts:81-89)" >&2; exit 1;; esac
# 이후 모든 API 호출에 -H "authorization: Bearer $TOKEN". 토큰을 로그·증거물에 남기지 않는다.
```

`/api/blogs`의 `connected:true`는 blogId/clientId/clientSecret 존재만 검사하고 **세션은 보지 않는다**(`src/platforms/naver/NaverAdapter.ts:148-152`). 세션 판정 근거로 쓰지 마라.

## 3. S1 — 라이브 스냅샷과 중복 판정

**중복 판정의 유일한 진실은 라이브 블로그(공개 목록)다.** SQLite `published_posts`는 참고용이며 신뢰하지 않는다 — 2026-09-15 실측: DB에 `published` 15행이 있는데 라이브 공개 게시물은 3건뿐이었다(나머지는 삭제/비공개). 실패 행의 `post_id`는 초안 id라서(`failed|naver|post-1789392253728-3a9qu`) "실패 행 = 미발행"도 성립하지 않는다.

```bash
curl -s "https://rss.blog.naver.com/$BID.xml" -o "data/ops/runs/$RUN_ID/live/rss-before.xml"
curl -s "https://blog.naver.com/PostList.naver?blogId=$BID&widgetTypeCall=true&noTrackingCode=true&directAccess=false" \
  -o "data/ops/runs/$RUN_ID/live/list-before.html"

grep -o "blog.naver.com/$BID/[0-9]*" "data/ops/runs/$RUN_ID/live/rss-before.xml" | sort -u   # 제목·pubDate·tag도 함께 기록
grep -o "logNo=[0-9]*" "data/ops/runs/$RUN_ID/live/list-before.html" | sort -u
```

후보 주제마다 기존 게시물 존재 여부를 확인한다(제목 뿐 아니라 카테고리·앵글도 본다):

```bash
curl -s "https://blog.naver.com/PostView.naver?blogId=$BID&logNo=<logNo>&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false" \
  | grep -c "se-main-container"
# ≥1 = 공개 / 0 = 비공개("비공개 글 입니다") 또는 삭제("삭제되었거나 다른 페이지로 변경되었습니다.")
```

RSS `<channel><pubDate>`는 게시물 시각이 아니다(실측: 아이템 최신 09-14인데 채널은 09-15로 표기). **아이템의 pubDate만** 쓴다.

## 4. S2–S4 — 수요 조회 (실데이터, 추정 금지)

```bash
# (1) 분야 인기검색어 TOP20 + 클릭 추이 + 비중. cat_id는 목록에서 고른다(추측 금지)
#     주의: categoryName 같은 비ASCII 값을 URL에 그대로 넣으면 업스트림이 400({"error":"Bad Request","message":"Client Error"})을 돌려준다.
#     실측(2026-09-15): categoryName=패션의류 인라인 → 400 / 같은 값 --data-urlencode → 200. ASCII 이름이나 이름 생략도 200. → 반드시 -G --data-urlencode로 보낸다.
curl -s "$API/api/keywords/shopping-categories" -H "authorization: Bearer $TOKEN" | jq '.categories' | head -40
curl -s -G "$API/api/keywords/category-overview" -H "authorization: Bearer $TOKEN" \
  --data-urlencode "category=<cat_id>" --data-urlencode "categoryName=<이름>" \
  --data-urlencode "startDate=<8주 전>" --data-urlencode "endDate=<어제>" --data-urlencode "timeUnit=week" \
  | tee "data/ops/runs/$RUN_ID/keyword/candidates.json" | jq '{categoryValid, clickTrend: (.clickTrend|length), keywords: [.keywords[].keyword]}'

# (2) 검색어트렌드(주간 상대지수) — 후보별로 1회씩
curl -s -X POST $API/api/keywords/trend -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source":"search-trend","query":"트위드자켓","startDate":"<12~16주 전>","endDate":"<어제>","timeUnit":"week"}' \
  | tee "data/ops/runs/$RUN_ID/keyword/trend-트위드자켓.json" | jq '{trend: .series[0].trend, first: .series[0].data[0], last: .series[0].data[-1]}'

# (3) 분야 클릭지수(쇼핑인사이트, 카테고리 단위 — query 불필요)
curl -s -X POST $API/api/keywords/trend -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source":"shopping-insight","criteria":"category","category":"<cat_id>","categoryName":"<이름>","startDate":"<8주 전>","endDate":"<어제>","timeUnit":"week"}'

# (4) 경쟁 문서량 (포화도)
KW=$(node -p "encodeURIComponent('트위드자켓')")
curl -s "$API/api/keywords/$KW/blogs?limit=10&sort=sim"  -H "authorization: Bearer $TOKEN" | jq .total   # 유사도순
curl -s "$API/api/keywords/$KW/blogs?limit=10&sort=date" -H "authorization: Bearer $TOKEN" | jq .total   # 최신순
```

- 응답의 `ratio`는 **조회 구간 내 최댓값=100인 상대 지수**다. 절대 검색량이 아니다.
- 조회 기간·시각을 그대로 기록한다(실측 예: 인기검색어 2026-08-14–09-14 월 단위, 검색어트렌드 2026-06-01–09-13 주 단위, 조회 22:17–22:20 KST).
- 후보는 **3~5개 이상** 비교한다. 탈락한 후보와 탈락 사유도 남긴다.

## 5. S5 — 주제 선정 (판단: 사람/에이전트 승인 필요)

선정 조건(모두 만족):

1. 최근 4주 이상 **상승 또는 견조**(시계열을 직접 읽어 판단).
2. 문서량이 상대적으로 낮음(`sort=sim`/`sort=date` 둘 다 확인).
3. 라이브 목록과 **중복 없음**(표기 변형 `트위드자켓`/`트위드 자켓`도 중복으로 본다).
4. **경험 없이 기준형(구매 가이드)으로 정직하게 쓸 수 있음.** 쓸 수 없으면 탈락.
5. 분야 클릭지수도 함께 상승.

탈락 기준(실측 예): 급락(제습기 29.30→7.42) · 시즌 종료 임박(예초기: 10월 급락) · 전년 대비 하락(비데) · 경쟁 3배(바람막이) · 보합·포화(김치냉장고·음식물처리기·텀블러).

**기록 요건(필수)**: `data/ops/runs/$RUN_ID/keyword/decision.md` — 한국어로 ① 출처·조회 시각 ② 조회 기간 ③ 후보별 수치와 탈락 사유 ④ 선정 근거 ⑤ "상대 지수이며 절대 검색량이 아니다" 명시. 이 근거 없이 발행하지 않는다.

후보가 하나도 조건을 통과하지 못하면 **발행하지 않고 종료**한다(`outcome: "skipped-no-candidate"`). 주기를 채우려고 억지 발행하지 마라.

## 6. S6–S9 — 생성·편집

```bash
# 초안 생성 → 폴링
curl -s -X POST $API/api/posts/generate-from-keyword -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keyword":"트위드자켓","template":"coupang-buying-guide"}'          # → {"post":{"id":"post-..."}}
DRAFT=<반환된 id>
curl -s "$API/api/posts/$DRAFT" -H "authorization: Bearer $TOKEN" | jq '{generationStatus: .post.generationStatus, len: (.post.content|length)}'
# generationStatus=="generating" 이면 대기, "failed" 이면 중단(발행 금지)

# 편집 저장 (generating 중에는 409로 거부된다)
curl -s -X PUT "$API/api/posts/$DRAFT" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"title\":\"...\",\"content\":$(jq -Rs . < data/ops/runs/$RUN_ID/draft/edited.html)}"
```

**작성 규칙 — 아래는 전부 발행 금지 사유다.**

| 항목       | 규칙                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1인칭 체험 | 금지. `제가` `저는` `써봤` `입어봤` `내돈내산` `제가 직접` 0회여야 한다(템플릿 기본 도입부가 1인칭 체험담을 생성하므로 **반드시 지운다**)    |
| 가격·수치  | 근거 없는 가격대·검증 불가 수치 금지. 상대 지수는 지수임을 명시                                                                              |
| 스텁 문구  | `향후 구현` `구현 예정` `coming soon` 0회                                                                                                    |
| 링크       | 실측 200 + 의도한 목적지인 것만 2~3건. 주제 무관 링크·`#`·상대경로 금지 (실측: 드라마 의상 링크 10건 제거)                                   |
| 이미지     | 생성 3장 중 실제로 맞는 것만 사용(실측은 1장). 캡션 `이해를 돕기 위한 예시 이미지 (AI 생성)` 필수. 특정 제품·브랜드를 식별시키는 이미지 금지 |
| 제휴       | 실제 제휴 링크가 있으면 고지 1회, 없으면 **고지도 넣지 않는다**(정합성). 허위 체험·허위 고지 금지                                            |
| 구조       | `.se-main-container`에 직렬화되지 않는 요소 금지: iframe 0, `⟦IMGn⟧` 플레이스홀더 0                                                          |

편집 후 발행 직전 HTML을 `data/ops/runs/$RUN_ID/draft/publish-preview.html`로 저장하고 sha256을 기록한다:

```bash
curl -s "$API/api/posts/$DRAFT/publish-preview?platform=naver" -H "authorization: Bearer $TOKEN" | jq -r .html > "data/ops/runs/$RUN_ID/draft/publish-preview.html"
shasum -a 256 "data/ops/runs/$RUN_ID/draft/publish-preview.html"   # macOS 표준(/usr/bin/shasum). 이 박스의 /sbin/sha256sum과 같은 해시를 내는 것을 확인했지만 PATH 의존을 피한다
```

## 7. S11 — 발행 게이트 (정확히 1회, 비가역)

발행 전 확인: S0 통과 · S1 중복 없음 · S3 결정 기록 존재 · 위 작성 규칙 전부 0회 · preview sha256 기록. **승인 없이 호출하지 않는다.**

```bash
curl -s -X POST "$API/api/posts/$DRAFT/publish" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"platform":"naver","visibility":"public","aiPolish":false}' \
  | tee "data/ops/runs/$RUN_ID/publish/response.json"
```

- `aiPolish`는 반드시 `false`. 기본값은 ON이고, 발행 시점에 본문 텍스트를 다시 쓰고 `post.html`까지 되저장한다 — 즉 검증한 본문과 발행본이 달라진다.
- 응답: `{"results":[{"platform":"naver","postId":"...","url":"...","success":true,"warnings":[],"widgetWarnings":[]}]}`
- **타임아웃·5xx·응답 없음 → 재호출 금지.** 먼저 라이브에서 확정한다(§8).
- `warnings` 또는 `widgetWarnings`가 비어있지 않으면 **재발행하지 않는다.** 발행물은 이미 살아 있으므로 결함을 `unresolved[]`에 적고 `outcome: "published-with-warnings"`로 종료한다.

## 8. S12 — 모호성 화해 (재호출 대신)

```bash
curl -s "https://rss.blog.naver.com/$BID.xml" -o "data/ops/runs/$RUN_ID/live/rss-after.xml"
grep -o "blog.naver.com/$BID/[0-9]*" "data/ops/runs/$RUN_ID/live/rss-before.xml" | sort -u > "data/ops/runs/$RUN_ID/live/logNos-before.txt"
grep -o "blog.naver.com/$BID/[0-9]*" "data/ops/runs/$RUN_ID/live/rss-after.xml"  | sort -u > "data/ops/runs/$RUN_ID/live/logNos-after.txt"
comm -13 "data/ops/runs/$RUN_ID/live/logNos-before.txt" "data/ops/runs/$RUN_ID/live/logNos-after.txt"
# 신규 0건 = 미발행(사람 승인 후에만 재시도) / 1건 = 발행됨 / 2건 이상 = 즉시 중단·사람 이관
# 비교 목록도 런 디렉터리에 남긴다(/tmp 금지). 프로세스 치환 없이 동작하므로 zsh·bash 어디서나 같다.
```

## 9. S13–S15 — 검증 (전부 통과해야 검수 완료)

```bash
# S13: 발행물 HTML 기계 점검 (텍스트 판정)
node scripts/inspect-published-post.mjs <logNo> $BID      # exit 0 = PASS, 1 = FAIL

# S14: 독자 시점 검증 — 모드 플래그(--links/--anon/--compliance)는 한 번에 하나만
node scripts/verify-reader-view.mjs <logNo> $BID --out "data/ops/runs/$RUN_ID/verify" --json | tee "data/ops/runs/$RUN_ID/verify/$RUN_ID-reader.log"
node scripts/verify-reader-view.mjs <logNo> $BID --out "data/ops/runs/$RUN_ID/verify" --links | tee "data/ops/runs/$RUN_ID/verify/$RUN_ID-links.log"
node scripts/verify-reader-view.mjs <logNo> $BID --out "data/ops/runs/$RUN_ID/verify" --compliance "output/posts/<draftId>" | tee "data/ops/runs/$RUN_ID/verify/$RUN_ID-compliance.log"

# S15: 비로그인 열람 가능 여부
node scripts/verify-reader-view.mjs <logNo> $BID --out "data/ops/runs/$RUN_ID/verify" --anon | tee "data/ops/runs/$RUN_ID/verify/$RUN_ID-anon.log"

# (선택) 하네스 자체 점검 — npm 별칭: npm run ops:verify -- <인자…> / npm run ops:verify:selftest
node scripts/verify-reader-view.mjs --selftest             # exit 0 = 검출기 정상
```

- 종료 코드는 셋 다 동일하다: **0 통과 / 1 실패 / 2 하네스 오류**(인자·의존성·네트워크).
- 위 `| tee` 파이프의 종료 코드는 §1의 `set -o pipefail`이 켜져 있을 때 하네스 것이다. 켜지 않았다면 `tee`가 0을 돌려줘 실패가 숨는다 — 파이프 없이 돌려 `$?`를 직접 확인하라.
- 인자는 순서 무관(`logNo`는 숫자, `blogId`는 아님). `blogId` 생략 시 env → config에서 해석한다.
- `--out` 기본값은 `.cache/reader-verify`다 — **반드시 `--out`을 증거 패킷으로 지정**해야 증거가 남는다.
- `--compliance`는 초안 **디렉터리**(`output/posts/<draftId>`, `post.html`+`meta.json` 포함)를 받는다.
- 이 스크립트는 익명 임시 컨텍스트만 사용하며 운영 프로필(`data/browser-profiles/naver`)을 열지 않는다(동시 사용 시 세션 파손 방지).
- 스크립트가 없거나 2(하네스 오류)로 끝나면 **검증을 생략하지 말고** 중단·보고한다.

통과 기준(실측값, 이보다 나빠지면 FAIL로 취급해 사람에게 이관):

| 항목           | 기준                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inspector      | exit 0, 컴포넌트 수 > 0, 네이버 호스팅 이미지 = 본문 이미지 수, `⟦IMGn⟧` 0회, 스텁 문구 0회, iframe 0, 중복 발행 no                                                                                                       |
| reader         | 문서 200 + `.se-main-container` 존재(PC·모바일 **모두**)                                                                                                                                                                  |
| 독자(비로그인) | 본문 텍스트가 원본과 동일(실측 4,728자 / 29컴포넌트), 깨진 이미지 0, 이미지 non-2xx 0, `text/html`로 서빙된 이미지 0, `존재하지 않는 이미지입니다` 0회, 빈 앵커(`#`·상대경로) 0, 중복 블록 0, 잘린 표 0, 가로 스크롤 없음 |
| compliance     | 초안 블록 유실 0, 금지 문구 0, `meta.json` 태그가 발행물에 전부 존재                                                                                                                                                      |
| links          | 본문 링크 전부 200 + 의도한 목적지                                                                                                                                                                                        |
| anon           | 인증 쿠키 없음 + 로그인 월 없음                                                                                                                                                                                           |
| 증거           | PC·모바일 스크린샷 파일이 `--out` 디렉터리에 생성                                                                                                                                                                         |

## 10. S16–S17 — 판정과 기록

**검수 완료 = 아래를 전부 만족할 때만이다**: ① `inspect-published-post.mjs` exit 0, ② `verify-reader-view.mjs`를 4회(기본 reader-view · `--links` · `--compliance` · `--anon`) 실행해 **전부 exit 0**, ③ 발행 응답의 `warnings`/`widgetWarnings`가 비어 있음. 그 외에는 `published-with-warnings` 또는 `FAIL`로 기록하고 사람이 판단한다(발행 후 수정 수단이 없으므로 판정만 남긴다).

증거 패킷(레포 하위, `/tmp` 금지 — 재부팅 시 소실):

```
data/ops/runs/$RUN_ID/
  run.json          # 아래 필드의 JSON
  report.md         # 한국어 운영 보고(제목·logNo·URL·태그·선정근거·검증수치·남은 결함)
  live/             rss-before.xml, list-before.html, rss-after.xml, logNos-before.txt, logNos-after.txt
  keyword/          candidates.json, trend-<키워드>.json, blogs-<키워드>.json, decision.md
  draft/            edited.html, publish-preview.html (+.sha256), meta.json
  publish/          response.json  (= 발행 응답 원문)
  verify/           <logNo>-inspector.txt, <runId>-reader.log, <runId>-links.log, <runId>-compliance.log, <runId>-anon.log,
                    <logNo>-desktop.png, <logNo>-mobile.png (스크린샷은 하네스가 --out에 직접 생성)
```

`data/ops/publish-log.jsonl`에 **1줄** 추가한다(append-only):

```json
{
  "runId": "...",
  "rulesHash": "<git hash-object .omp/skills/naver-blog-cycle/SKILL.md>",
  "keyword": "...",
  "keywordDecision": {
    "source": "...",
    "queriedAt": "...",
    "window": { "rank": "...", "trend": "..." },
    "series": [
      ["2026-06-01", 26.49],
      ["2026-09-07", 100]
    ],
    "saturation": { "sortSim": 0, "sortDate": 0 },
    "candidates": ["..."],
    "basis": "..."
  },
  "draftId": "post-...",
  "content": { "htmlSha256": "...", "aiPolish": false },
  "images": { "generated": 3, "used": 1 },
  "publish": {
    "attempts": 1,
    "visibility": "public",
    "tags": ["..."],
    "logNo": "...",
    "url": "...",
    "warnings": [],
    "widgetWarnings": []
  },
  "verification": {
    "inspector": { "exit": 0 },
    "reader": { "exit": 0, "verdict": "PASS" },
    "anonymous": { "authCookies": [], "loginWall": false },
    "newLogNos": ["..."]
  },
  "cost": { "imagesUsd": 0.033 },
  "outcome": "published",
  "unresolved": []
}
```

`outcome`: `published` | `published-with-warnings` | `skipped-no-candidate` | `aborted-<reason>`.

## 11. 주기·중복 정책

| 항목        | 값                                                                     | 근거                                                                               |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 기본 주기   | **주 2회** (화·토 21:00–23:00 KST)                                     | 트렌드 신호가 주 단위(`timeUnit=week`)이고, 실측 발행 시각이 21:12·21:19·22:42 KST |
| 상한        | 주 3회                                                                 | 자동 대량 구간(2026-08-28~09-08, DB 15행)은 라이브에 **0건** 남았다                |
| 연속 제한   | 같은 카테고리 연속 발행 금지                                           | 중복·저품질 구간 재현 방지                                                         |
| 중복 윈도우 | 동일 키워드/주제 **180일**, 계절 키워드는 **365일**(같은 시즌 창 회피) | 계절 지수는 시즌 종료 시 붕괴(예초기 10월 급락, 제습기 →7.42)                      |
| 후보 없음   | `skipped-no-candidate`로 종료                                          | 실측 후보 7개 중 통과 1개                                                          |

## 12. 실패·중단 프로토콜 (사람 이관)

| 상황                                                    | 행동                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NID_AUT 없음 / 만료 임박(14일 미만)                     | 중단(`aborted-login`). 사람에게 `npm run naver:login` 요청. 자동 로그인 금지                                                                                   |
| `NAVER_LOGIN_REQUIRED` 응답                             | 위와 동일. 재시도 금지                                                                                                                                         |
| `PlatformError: ... at step "<step>"` (예: `fill-tags`) | 스크린샷 경로(`output/naver-debug/*.png`)와 step명을 그대로 보고. **같은 단계가 3회 실패하면 중단·사람 이관.** 스텝을 우회하거나 순서를 바꿔 재시도하지 않는다 |
| 초안 `generationStatus:"failed"` / LLM 오류             | 중단(`aborted-llm`). 발행 금지                                                                                                                                 |
| 이미지 일일 상한(20장) 도달                             | 중단(`aborted-image-budget`)                                                                                                                                   |
| 발행 응답 timeout/모호                                  | 재호출 금지 → §8 RSS 화해                                                                                                                                      |
| 검증(§9) 실패                                           | 재발행 금지. 발행물은 살아 있으므로 결함을 `unresolved[]`에 기록하고 사람에게 이관                                                                             |
| 동일 초안 재발행 필요                                   | 자동 판단 금지. 사람 승인 필요                                                                                                                                 |

## 13. 한눈에 보는 금지 목록

`platform:"naver"` 외 발행 금지 · `visibility:"public"` 외 금지 · `aiPolish:false` 외 금지 · publish 2회 이상 금지 · 삭제 금지 · 스케줄러/타 플랫폼 활성화 금지 · 1인칭 체험·허위 고지 금지 · 경험 없는 주제 금지 · 검증 없는 발행 금지 · `/tmp`에만 증거 남기기 금지.
