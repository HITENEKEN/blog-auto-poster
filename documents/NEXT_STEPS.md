# 다음 단계 실행 가이드 (쿠팡 승인 후 즉시 실행)

> **목적**: 쿠팡 파트너스 승인 완료 후 즉시 자동화 시스템을 가동하기 위한 체크리스트

---

## 📋 사전 준비 완료 확인

- [ ] 네이버 블로그 3~5개 글 작성 및 발행 완료
- [ ] 쿠팡 파트너스 매체 승인 완료 (상태: "승인됨")
- [ ] 쿠팡 파트너스 API 키 발급 완료 (Access Key, Secret Key, Tracking ID)
- [ ] 티스토리/워드프레스 블로그 개설 및 API 키 발급
- [ ] 프로젝트 클론 및 의존성 설치 완료

---

## ⚡ 즉시 실행 단계 (순서대로 실행)

### 1. 시크릿 설정
```bash
cd blog-auto-poster
cp config/secrets.yaml.example config/secrets.yaml
vim config/secrets.yaml
```

**필수 입력 항목:**
```yaml
affiliates:
  coupang:
    apiKey: "여기에_Coupang_API_Key_입력"
    apiSecret: "여기에_Coupang_API_Secret_입력"
    trackingId: "여기에_트래킹_ID_입력"  # 서브 ID
```

### 2. 빌드 및 검증
```bash
cd blog-auto-poster
npm install --legacy-peer-deps
cd src/web/client && npm install && npm run build && cd ../..
npm run build
```

### 3. 설정 검증 (CLI 위자드)
```bash
npm run cli -- config
# 대화형으로 설정 검증 후 저장
```

### 4. 테스트 실행 (드라이런)
```bash
# 1) 키워드 리서치 테스트
npm run cli -- research "무선청소기" --limit=5

# 2) 포스트 생성 테스트 (드라이런)
npm run cli -- generate \
  --template=coupang-product-review \
  --product=123456789 \
  --platform=tistory \
  --dry-run

# 출력 확인: ./output/posts/post-*/post.html
```

### 5. 스케줄러 활성화
```bash
# 일일 작업 활성화
npm run cli -- schedule enable daily-keyword-research
npm run cli -- schedule enable daily-content-generation
npm run cli -- schedule enable daily-publishing
npm run cli -- schedule enable hourly-analytics-sync

# 스케줄 확인
npm run cli -- schedule list
```

### 6. 프로덕션 실행 (PM2)
```bash
# 스케줄러 백그라운드 실행
pm2 start dist/cli/index.js --name "blog-poster-scheduler" -- schedule

# 웹 서버 실행
pm2 start dist/web/server/index.js --name "blog-poster-web"

# 상태 확인
pm2 list
pm2 logs blog-poster-scheduler --lines 50
pm2 logs blog-poster-web --lines 50
```

### 6. 웹 대시보드 접속
- URL: http://localhost:3000
- 로그인: `admin` / `changeme` (config/secrets.yaml에서 변경 가능)
- 확인할 메뉴:
  - **대시보드**: 통계 카드, 차트, 최근 활동
  - **블로그 관리**: 연동 상태, 카테고리 동기화
  - **쿠팡 현황**: 수익/클릭/전환 차트
  - **키워드 리서치**: 검색/필터/정렬
  - **자동 포스팅 설정**: 스케줄 ON/OFF, 크론 편집

---

## 📅 자동화 일정 확인

| 시간 | 작업 | 설명 |
|------|------|------|
| 06:00 | 키워드 리서치 | 네이버/구글/쿠팡 멀티 프로바이더 |
| 07:00 | 콘텐츠 생성 | 템플릿 렌더링 + AI 이미지 + SEO |
| 08:00 | 멀티 플랫폼 발행 | 티스토리/워드프레스/유튜브 쇼츠 |
| 매시간 | 분석 동기화 | 조회수/클릭/수익/전환율 동기화 |

---

## 🔍 모니터링 포인트 (첫 주)

| 지표 | 확인 주기 | 정상 기준 |
|------|-----------|-----------|
| 발행 성공률 | 매일 | 90% 이상 |
| 키워드 리서치 품질 | 주간 | 상위 10개 중 5개 이상 유효 |
| 쿠팡 클릭/전환 | 주간 | CTR 1% 이상, 전환율 0.5% 이상 |
| 에러 로그 | 매일 | 크리티컬 에러 0건 |
| 작업 큐 적체 | 매시간 | QUEUED < 10개 |

---

## 🚨 긴급 대응 체크리스트

### 발행 완전 중단 시
1. `pm2 list`로 프로세스 생존 확인
2. `pm2 logs --err`로 에러 로그 확인
3. `sqlite3 data/jobs.sqlite "SELECT COUNT(*) FROM jobs WHERE status='RUNNING';"` 멈춘 작업 확인
4. `pm2 restart all` 전체 재시작

### 쿠팡 수익 0원 지속 시
1. `config/secrets.yaml`의 `trackingId` 확인 (서브 ID 필수)
2. 쿠팡 파트너스 센터에서 승인 상태 확인
3. 발행된 포스트의 제휴 링크 직접 클릭 테스트
4. `npm run cli -- analytics --days=7`로 클릭/전환 수 확인

### 데이터 손실 의심 시
1. `data/backups/` 최신 백업 확인
2. `sqlite3 data/jobs.sqlite ".backup data/emergency-backup.sqlite"` 즉시 백업
3. `sqlite3 data/jobs.sqlite "PRAGMA integrity_check;"` 무결성 검사
4. 필요 시 백업에서 복원

---

## 📞 참고 문서

| 문서 | 용도 |
|------|------|
| `documents/01-overview.md` | 시스템 전체 구조 파악 |
| `documents/02-architecture.md` | 아키텍처/데이터플로우/인터페이스 |
| `documents/03-api.md` | REST API/WebSocket 연동 |
| `documents/04-tech-stack.md` | 기술 스택/버전/외부 API |
| `documents/05-database.md` | DB 스키마/Job 상태/재시도 정책 |
| `documents/07-roadmap.md` | Phase 1~4 로드맵/마일스톤 |
| `documents/08-extension-guide.md` | 새 어댑터/템플릿/잡 추가 방법 |
| `documents/09-troubleshooting.md` | 장애 해결/디버깅 팁 |
| `documents/10-naver-blog-bootstrap.md` | 네이버 블로그 승인 가이드 |