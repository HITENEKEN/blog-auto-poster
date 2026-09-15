# 네이버 블로그 주기 발행 런북 (스킬·트리거·주기/중복·증거)

> **목적**: 2026-09-14에 1회 성공한 네이버 블로그 발행 사이클(검색수요 조회 → 주제 선정 → 생성·편집 → 공개 발행 → 독자 검증)을 **주기 실행**으로 전환한다. 이 문서는 *왜*와 *배선(wiring)*을 다루고, 실행 계약은 `.omp/skills/naver-blog-cycle/SKILL.md`(이하 **스킬**)가 갖는다.
> 스킬 파일이 단계·명령·게이트의 단일 출처이며, 이 문서는 그 단계 목록을 재기재하지 않는다.
> **작성**: 2026-09-15 / **트리거(launchd) 로드**: 미실행 — §3은 설치 절차이며 이 문서 작성 시점에 `launchctl`로 로드하지 않았다.

---

## 1. 현행 자동화 인벤토리

"이미 자동화가 있으니 스케줄만 켜면 된다"는 가정이 **성립하지 않는다**.

| 항목                             | 실측                                                                                                                                                                        | 근거                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 잡 큐가 write-only               | `registerProcessor()`가 **정의만 있고 호출 0건** → 큐에 넣어도 소비하는 프로세서가 없다                                                                                     | `src/scheduler/JobQueue.ts:130,159,264`                                           |
| 방치된 잡                        | `job-1787915077668-6o4ddf / RESEARCH / QUEUED / 2026-08-28T11:04:37.668Z / attempts=0` (2026-09-15 기준 18일 방치)                                                          | `data/jobs.sqlite` `jobs` 테이블, `/health`의 `jobQueue.byType.RESEARCH.QUEUED=1` |
| 스케줄러 미기동                  | 웹 서버는 스케줄러 객체를 만들지만 `scheduler.enabled=false`라 `start()`를 호출하지 않는다 → `/health`가 `scheduler:"stopped"`                                              | `src/web/server/index.ts:73-77`, `:172`                                           |
| CLI `publish`는 스텁             | "Publish command requires the platforms module which is not included in this build."만 출력                                                                                 | `src/cli/index.ts:361-375`                                                        |
| `schedule enable/disable` 무영속 | CLI가 매 실행마다 `config/default.yaml`에서 스케줄러를 새로 만들고, `enableJob/disableJob`은 메모리 `jobConfigs`만 바꾼다 → 변경이 사라진다                                 | `src/cli/index.ts:386,392,415,424`, `src/scheduler/CronScheduler.ts:117-131`      |
| 기본 스케줄 잡은 네이버가 아니다 | `daily-keyword-research`(06:00), `daily-content-generation`(07:00, `platforms:['tistory']`, `maxPostsPerRun: 5`)                                                            | `config/default.yaml:154-174`                                                     |
| PM2                              | 앱 1개 `blog-auto-poster-web`(=`scripts/start-web.js`)만 online. `~/.pm2/dump.pm2` 없음(`pm2 save` 미실행), `~/Library/LaunchAgents/pm2-*.plist` 없음(`pm2 startup` 미설정) | `pm2 jlist`, 파일 부재 확인                                                       |
| OS 스케줄러                      | `crontab -l` → `no crontab for prily`. launchd 사용자 에이전트에 blog-auto-poster 없음(hermes 계열만 존재)                                                                  | `crontab -l`, `~/Library/LaunchAgents/`                                           |
| GitHub Actions                   | CI만 수행(typecheck/lint/format/build). 러너에는 네이버 세션 프로필이 없다 — 프로필은 로컬 `data/browser-profiles/naver`에만 있고 `data/`는 gitignore                       | `.github/workflows/e2e.yml`, `.gitignore:10`                                      |
| 문서 드리프트                    | `documents/10-naver-blog-bootstrap.md:174-186`이 `npm run cli -- schedule enable …` + `pm2 start dist/cli/index.js -- schedule`를 안내하지만 위 이유로 동작하지 않는다      | `src/cli/index.ts:376-435`(CLI에 `schedule` 실행 액션이 없다)                     |

---

## 2. 왜 코드 스케줄러가 아니라 스킬 + 에이전트인가

사이클은 **17단계**이며, 각 단계는 (a) 완전 결정적 / (b) LLM·승인 게이트 필요 / (c) 환원 불가능한 판단으로 분류된다. 분류·명령 전문은 스킬에 있다. 여기서는 경계만 못박는다.

| 성격                | 지점                                                                                                                          | 왜 코드/큐로 못 옮기는가                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(c) 판단**        | S5 주제 선정, S7 이미지 적합성, S8 허위 체험 제거, S9 링크 적합성, S16 최종 판정                                              | 상대 지수만으로 "수요가 크다"를 결정할 수 없고, "경험 없이 기준형으로 쓸 수 있는가"·"이 이미지/링크가 실제 제품·주제와 맞는가"·"남은 결함을 받아들일 것인가"는 서술·품질 판단이다. 1건 실행에서 실제로 7개 후보 중 1개만 통과했고, 링크 10건이 제거됐고, 이미지 3장 중 1장만 쓰였다 — 전부 판단의 결과다 |
| **(b) 게이트**      | S11 발행                                                                                                                      | 호출은 기계적이지만 비가역이다. 사람/에이전트 승인과 "정확히 1회" 규율이 필요하다                                                                                                                                                                                                                        |
| **(a) 자동화 가능** | S0 프리플라이트, S1 라이브 스냅샷/중복 판정, S2–S4 수요 조회, S6 생성 트리거, S10 구조 검사, S12 화해, S13–S15 검증, S17 기록 | 전부 결정적이다. 이 부분은 §6의 백로그로 코드에 넣을 수 있고, 넣어야 한다                                                                                                                                                                                                                                |

따라서 정답은 **"판단은 에이전트, 게이트는 코드, 나머지는 스킬의 명령"** 이다. 큐/스케줄러를 켜는 방식은 판단 지점을 건너뛰고 곧바로 (b)를 실행하므로 이 사이클에 맞지 않는다.

---

## 3. 트리거 설치 (launchd user agent)

**왜 launchd + Aqua 세션인가**: 발행은 Playwright가 `data/browser-profiles/naver`의 **실제 Chrome 프로필**을 열어 NID_AUT 쿠키로 로그인 상태를 유지해야 한다(`src/platforms/naver/NaverBrowserPoster.ts:1190-1240`). 이 프로필은 로그인한 사용자의 GUI 세션에 속하므로, 시스템 데몬·헤드리스 러너가 아니라 **Aqua 세션의 사용자 에이전트**로 돌려야 한다.

`~/Library/LaunchAgents/com.prily.blog-auto-poster-cycle.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prily.blog-auto-poster-cycle</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/omp</string>
    <string>-p</string>
    <string>--cwd</string>
    <string>/Users/prily/Work/blog-auto-poster</string>
    <string>--append-system-prompt=/Users/prily/Work/blog-auto-poster/.omp/skills/naver-blog-cycle/SKILL.md</string>
    <string>--auto-approve</string>
    <string>--mode=json</string>
    <string>--max-time=5400</string>
    <string>skill://naver-blog-cycle 규칙에 따라 네이버 블로그 발행 1사이클을 실행하라.</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/prily/Work/blog-auto-poster</string>

  <!-- launchd 기본 PATH는 /usr/bin:/bin:/usr/sbin:/sbin 이라 omp·node를 못 찾는다. 반드시 덮어쓴다. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/prily</string>
  </dict>

  <!-- 주 2회: 화(2)·토(6) 21:10 KST. 0/7=일, 1=월, 2=화 … 6=토 -->
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Weekday</key><integer>2</integer>
      <key>Hour</key><integer>21</integer>
      <key>Minute</key><integer>10</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>6</integer>
      <key>Hour</key><integer>21</integer>
      <key>Minute</key><integer>10</integer>
    </dict>
  </array>

  <key>RunAtLoad</key>
  <false/>

  <!-- GUI 세션(Aqua)에서만 — 브라우저 프로필 접근에 필요 -->
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>

  <key>StandardOutPath</key>
  <string>/Users/prily/Work/blog-auto-poster/data/ops/launchd-cycle.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/prily/Work/blog-auto-poster/data/ops/launchd-cycle.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
```

위 XML을 **`~/Library/LaunchAgents/com.prily.blog-auto-poster-cycle.plist`로 저장한 뒤** 아래를 실행한다(경로를 바꾸면 `plutil`·`launchctl` 명령의 경로도 함께 바꾼다). launchd는 로그 디렉터리를 만들어 주지 않으므로 0)을 먼저 실행한다.

설치·확인·해제(이 문서 작성 시점에는 **실행하지 않았다**):

```bash
# 0) 로그 디렉터리 준비 (data/는 gitignore 대상 런타임 경로)
mkdir -p /Users/prily/Work/blog-auto-poster/data/ops

# 1) 문법 검사
plutil -lint ~/Library/LaunchAgents/com.prily.blog-auto-poster-cycle.plist

# 2) 등록 (uid 501 = prily)
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.prily.blog-auto-poster-cycle.plist

# 3) 즉시 1회 실행해 드라이런 확인 (-p: 시작한 프로세스 PID 출력)
launchctl kickstart -p gui/501/com.prily.blog-auto-poster-cycle

# 4) 상태/다음 실행 시각 확인
launchctl print gui/501/com.prily.blog-auto-poster-cycle

# 5) 해제
launchctl bootout gui/501/com.prily.blog-auto-poster-cycle
```

주의사항:

- `omp` 경로는 Homebrew 심볼릭 링크다(`/opt/homebrew/bin/omp` → `Cellar/omp/18.1.22`). 업그레이드 후에도 심볼릭 링크가 유지되므로 그대로 써도 된다. 버전을 고정하려면 실제 경로로 바꾼다.
- `-p --auto-approve`는 **무인 실행 전제**다. 승인 프롬프트가 뜨면 세션이 멈추므로 트리거 경로에서는 반드시 붙인다.
- `--max-time=5400`(90분)은 폭주 방지용 상한이다. 실측 1사이클은 조회부터 검증까지 약 30분(22:17–22:47 KST)이었다.
- launchd는 GUI 세션이 로그인돼 있을 때만 Aqua 에이전트를 띄운다. 화면 잠금·로그아웃 상태에서는 실행되지 않는다(의도된 동작 — 세션 프로필이 필요하므로).
- 산출 로그(`data/ops/launchd-cycle*.log`)는 JSON 모드 출력이므로 사람이 읽을 요약은 `data/ops/runs/<runId>/report.md`를 본다.

---

## 4. 주기·중복 정책

| 항목           | 값                                                                     | 근거 (실측)                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기본 주기      | **주 2회** (화·토 21:00–23:00 KST)                                     | 검색어트렌드를 `timeUnit=week`로 조회하므로 신호 갱신이 주 단위다. 라이브 발행 시각도 09-07 21:19, 09-09 21:12, 09-14 22:42 KST로 저녁 창에 몰려 있다 |
| 상한           | 주 3회                                                                 | 2026-08-28~09-08 자동 대량 구간은 DB에 `published` 15행을 남겼지만 **라이브에 남은 것은 0건**(삭제·비공개로 정리)이었다                               |
| 연속 제한      | 같은 카테고리 연속 발행 금지                                           | 중복·저품질 구간(09-03 게스청바지 4행/7분, 09-08 리바이스 4행) 재현 방지                                                                              |
| 중복 윈도우    | 동일 키워드/주제 **180일**, 계절 키워드는 **365일**(같은 시즌 창 회피) | 계절 지수는 시즌 종료 시 붕괴한다 — 예초기 상승 후 10월 급락, 제습기 29.30→7.42                                                                       |
| 중복 판정 소스 | **라이브 블로그(공개 목록)만**                                         | DB `published` 15행 vs 라이브 공개 3건(2026-09-15). 실패 행의 `post_id`는 초안 id라 "실패=미발행"도 성립하지 않는다                                   |
| 후보 없음      | 발행하지 않고 `outcome: "skipped-no-candidate"`로 종료                 | 실측 후보 7개 중 통과 1개(탈락: 급락·전년 대비 하락·경쟁 3배·보합·포화·하락)                                                                          |
| 비용           | 1사이클 = 이미지 3장 × $0.011 = **$0.033**                             | `output/images/.image-usage.json`(2026-09-14), `config/default.yaml:83-104`(gpt-image-1 low 1024×1024)                                                |

즉 "많이"보다 "상승 창에 정확히"가 목표다. 주기를 채우려는 억지 발행은 위 대량 구간의 재현이다.

---

## 5. 증거·감사

- 실행 기록은 **`data/ops/publish-log.jsonl`**(append-only, 1줄 = 1사이클)과 **`data/ops/runs/<runId>/`**(원문 응답·스크린샷·보고)에 남는다. 필드 목록과 경로 규약은 스킬 §10에 있다.
- `data/`는 `.gitignore:10`으로 제외된다. 의도된 선택이다 — 증거물에는 발행물 HTML·PNG(수 MB)가 포함되고, 발행 식별자(logNo)는 이미 공개 URL로 노출돼 있어 저장소에 커밋할 이유가 없다. 규약(경로·필드)만 이 문서와 스킬로 추적한다.
- **규칙 버전 추적**: 각 기록에 `rulesHash`(= `git hash-object .omp/skills/naver-blog-cycle/SKILL.md`)를 남긴다. 스킬 내용이 바뀌면 해시가 바뀌므로 "어느 규칙으로 발행한 글인가"를 사후에 재구성할 수 있다.
- `.omp/`는 gitignore 대상이 아니므로 스킬 파일 자체는 추적된다(규칙 변경이 커밋 이력에 남는다). 의도된 동작이며, `alwaysApply` 같은 전역 주입은 쓰지 않는다 — 이 스킬은 **온디맨드**여야 한다(다른 작업 세션의 컨텍스트를 오염시키지 않기 위해).

---

## 6. 미구현 기계 게이트 백로그

지금은 아래 항목이 **문서(스킬)로만** 막혀 있다. 즉 무인 실행에서 규칙을 어기면 막아주는 코드가 없다. 우선순위 순.

| 순위 | 게이트                                                                                                                   | 막는 사고                                                                                                        | 제안 위치                                                                                                                                                                                     | 현재 상태                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ①    | 동일 `draftId`/동일 제목 재발행 쿨다운(예: 24h) — 중복이면 409                                                           | 중복 발행 (동일 제목 4행/7분 실재, 실패 행이 초안 id로 기록)                                                     | `src/web/server/routes/index.ts:1342`(`POST /api/posts/:id/publish`) 초입 + `src/scheduler/JobQueue.ts:637`(`getPublishedPosts`)                                                              | 문서로만                                                                                                                            |
| ②    | `aiPolish` 미지정 시 거부(또는 기본 OFF)                                                                                 | 검증한 본문과 발행본 불일치 — 기본값이 ON이고 발행 시점에 본문을 다시 써서 `post.html`에 되저장                  | `src/web/server/routes/index.ts:1368`(`const aiPolish = aiPolishOpt !== false;`)                                                                                                              | 문서로만(`aiPolish:false` 명시 규율)                                                                                                |
| ③    | 발행 전 라이브 목록 대조(제목 중복이면 409)                                                                              | 재발행·중복 주제                                                                                                 | `src/web/server/routes/index.ts:1521` 부근(`adapter.createPost` 직전) — RSS/PostList 조회 추가                                                                                                | 문서로만(스킬 S1)                                                                                                                   |
| ④    | `publish-preview` 구조 게이트를 **발행 전**으로 승격                                                                     | 조용한 유실: 링크/이미지 부족, 스텁 문구, `⟦IMGn⟧` 잔존. 현재 점검은 발행 **후**에만 돌고 실패는 경고로 강등된다 | 점검 실행: `src/platforms/naver/NaverBrowserPoster.ts:1660-1674`; 순수 함수는 재사용 가능 — `src/platforms/naver/PublishedPostInspector.ts`(`summarizePublishedPost`/`evaluatePublishedPost`) | 문서로만(스킬 S10)                                                                                                                  |
| ⑤    | `/health`에 네이버 세션 만료 노출                                                                                        | 무인 실행의 로그인 만료(발행 직전까지 알 수 없음)                                                                | `src/platforms/naver/NaverAdapter.ts:148-152`(`validateCredentials`는 static config만 확인) → `/health`(`src/web/server/index.ts:160-186`)에 `nidAutExpiresAt` 노출                           | 문서로만(스킬 S0이 프로필 쿠키를 직접 읽음)                                                                                         |
| ⑥    | 검증 하네스 승격(모드: 기본 reader-view · `--links` · `--compliance <draftDir>` · `--anon` · `--selftest`) 및 npm script | 증거 소실(하네스가 `/tmp` throwaway였음) 및 검증 생략                                                            | `scripts/verify-reader-view.mjs`, `package.json`의 `ops:verify`/`ops:verify:selftest`                                                                                                         | **승격 완료**(2026-09-15, 커밋 대기) — 스킬 §9가 실제 CLI를 가리킨다. 남은 규율: 실행마다 `--out data/ops/runs/<runId>/verify` 지정 |

---

## 7. 리스크 (무인 실행 시 파손 지점 순위)

| 순위 | 리스크                 | 실측 근거                                                                                                                                                                 | 완화책                                                                                                        | 현재 방어                       |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1    | 모호성에서 중복 발행   | 동일 제목 4행/7분(09-03)·4행(09-08); #25 1차 실패 행이 초안 id로 기록되고 이후 실제 발행                                                                                  | publish는 실행당 1회, 타임아웃 시 재호출 금지 → RSS로 확정                                                    | 스킬 S11/S12 (문서) + 백로그 ①③ |
| 2    | warn-and-continue 유실 | 경고는 **발행 후**에만 도착(`publishWarnings.push` 11곳), 회수 실패 이미지는 본문에서 제거, 핫링크 이미지는 차단 환경에서 `존재하지 않는 이미지입니다.` 4회(224405221163) | pre-publish 구조 게이트 + `warnings`/`widgetWarnings` 공백 요건, 위반 시 재발행 없이 결함 기록                | 스킬 S10/S9 + 백로그 ④          |
| 3    | 세션 만료              | 실측 쿠키: NID_AUT 2027-10-19, **NID_SES 2026-10-14**, NID_SAUTO 2026-09-28                                                                                               | S0에서 만료 확인, 14일 미만이면 중단·사람이 `npm run naver:login`                                             | 스킬 S0 + 백로그 ⑤              |
| 4    | 에디터 DOM 드리프트    | #25가 정확히 이것 — `fill-tags`가 발행 설정 모달 이전에 실행돼 첫 발행 중단(수정 `40119c4`)                                                                               | step명 + `output/naver-debug/*.png` 스크린샷을 근거로 이관, 같은 단계 3회 실패 시 중단. 스텝 우회 재시도 금지 | 스킬 §12                        |
| 5    | LLM 장애/품질          | 초안 생성 실패 시 `generationStatus:"failed"`; polish 실패는 조용히 원본 폴백                                                                                             | 상태 폴링 후 진행, `aiPolish:false` 고정                                                                      | 스킬 S6/S7 + 백로그 ②           |
| 6    | 이미지 낭비·쿼터       | 3장 중 2장 폐기(손상 1·불일치 1) → 실사용 33%; 일일 상한 20장, 비용 상한 미설정                                                                                           | 원장 확인 후 생성, `maxImagesPerPost: 3` 유지, `dailyCostLimitUsd` 하드 게이트화                              | 스킬 S0                         |
| 7    | 외부 CDN 이미지 차단   | 쿠팡 CDN 핫링크 실패 이력, 리호스팅 캐시 5건(`data/naver-remote-images.json`)                                                                                             | `rehostRemoteImages=true` 유지, 익명 검증이 이미지 응답 실패를 잡는다                                         | 스킬 S9                         |
| 8    | 계정·정책 리스크       | 자동 대량 구간 15행이 전부 삭제·비공개로 정리됨                                                                                                                           | 저빈도·1회 1건·삭제 금지·사람 승인                                                                            | 스킬 §0/§11/§13                 |
| 9    | 정직성 회귀            | 템플릿 기본값이 1인칭 체험담과 예산별 추천 문구를 생성                                                                                                                    | 금지어 스캔 0건 + 링크 200/적합성 게이트                                                                      | 스킬 S8/S9                      |
| 10   | 증거 소실              | 검증 하네스가 `/tmp` throwaway였고 결과도 `/tmp`에만 남았다                                                                                                               | `data/ops/runs/<runId>/` 규약(하네스는 승격 완료, `--out` 지정 필요)                                          | 스킬 S17 + 백로그 ⑥             |
| 11   | 환경 드리프트          | 운영 3002 / dev 3005, PM2 재시작·`dist` 반영 수동 확인                                                                                                                    | S0에서 `/health`(version·platforms·scheduler) 고정 확인, API base 상수화                                      | 스킬 S1                         |
| 12   | 규칙 문서 노후화       | 규칙만 참조하고 버전을 안 남기면 사후 추적 불가                                                                                                                           | 기록에 `rulesHash` 저장                                                                                       | 스킬 S17                        |

---

_작성일: 2026-09-15 | 실행 계약: `.omp/skills/naver-blog-cycle/SKILL.md` (§3 트리거는 미로드 상태)_
