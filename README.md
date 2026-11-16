# 식단 기록 — 이미지 기반 다이어트 기록 웹앱

음식 사진을 찍으면 AI(Gemini)가 음식명·카테고리·추정 중량·탄단지를 분석해 기록합니다.
메인은 달력이고, 하루 단위로 식단·운동 여부·체중을 기록하며, 통계와 **AI 주간 목표 칼로리 조정**을 제공합니다.
모바일 우선 반응형 PWA 입니다.

```
diet/
├─ backend/                 Node.js + TypeScript + Express + PostgreSQL
│  ├─ db/schema.sql         DB 스키마 (그대로 실행, 여러 번 실행해도 안전)
│  ├─ prompts/              시스템 프롬프트
│  │  ├─ food_analysis.md       이미지 분석
│  │  └─ weekly_adjustment.md   주간 칼로리 조정
│  ├─ src/
│  │  ├─ routes/            REST API (/api/...)
│  │  ├─ services/          인증·분석 작업·Gemini 키 풀·주간 조정·안전장치
│  │  ├─ lib/               KST 시간·영양 계산·비밀번호·JWT
│  │  ├─ jobs/scheduler.ts  내장 배치 (월 00:05 KST)
│  │  └─ scripts/           db:init, job:weekly
│  ├─ test/                 단위 테스트 (vitest)
│  └─ .env.example
└─ frontend/                React + Vite + TypeScript (PWA)
   ├─ public/               manifest, service worker, 아이콘
   └─ src/
      ├─ pages/             달력·일별·통계·프로필·인증
      ├─ components/        무음 카메라·식사 추가 흐름·차트 등
      ├─ api/ auth/ time/   API 클라이언트·인증·서버 시각
      └─ lib/
```

---

## 1. 실행 방법

### 준비물
- Node.js **22 이상** (개발/검증: 24.15)
- PostgreSQL **15 이상**

### 1) DB 만들기
```bash
createdb diet                         # 또는 CREATE DATABASE diet;
psql "postgres://USER:PASS@localhost:5432/diet" -v ON_ERROR_STOP=1 -f backend/db/schema.sql
# psql 이 없으면: cd backend && npm run db:init   (DATABASE_URL 사용)
```

### 2) 백엔드
```bash
cd backend
cp .env.example .env        # DATABASE_URL, JWT_SECRET, GEMINI_API_KEYS, SMTP 를 채운다
npm install
npm run dev                 # http://localhost:4000
```
- 로컬 http 로 개발할 때는 `.env` 에 `COOKIE_SECURE=false`
- Gemini 키 없이 화면 흐름만 보려면 `AI_MOCK=true` (production 에서는 무시됨)
- 메일 서버 없이 개발하려면 `MAIL_TRANSPORT=console` (임시 비밀번호가 서버 콘솔에 출력됨, 개발용)

### 3) 프론트엔드
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173  (/api 는 4000 으로 프록시)
```
> 앱 내 무음 카메라(getUserMedia)는 **HTTPS 또는 localhost** 에서만 동작합니다. 휴대폰으로 테스트할 때는 HTTPS 로 배포하거나 HTTPS 터널을 사용하세요.

### 4) 운영 빌드 / 배포
```bash
cd backend && npm run build && NODE_ENV=production npm start
cd frontend && npm run build        # dist/ 를 정적 호스팅
```
Refresh Token 쿠키가 `SameSite=Strict` 이므로 **프론트와 API 를 같은 출처**로 두는 구성을 권장합니다 (리버스 프록시).

```nginx
server {
  listen 443 ssl http2;
  server_name diet.example.com;
  root /srv/diet/frontend/dist;
  client_max_body_size 11m;                 # 업로드 10MB
  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 40s;                 # 분석 long-poll(최대 25초)
  }
  location / { try_files $uri /index.html; }
}
```
이때 백엔드 `.env`: `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`.

---

## 2. 배치(주간 칼로리 조정) 설정

매주 **월요일 00:05 KST** 에 지난 4주 데이터를 보고 이번 주 목표를 정합니다.

### 방법 A — 내장 스케줄러 (기본)
`ENABLE_SCHEDULER=true` 이면 서버 프로세스가 직접 실행합니다.
| 시각 (KST) | 내용 |
|---|---|
| 월 00:05 | 본 실행 |
| 월 01:05 ~ 22:05 매시 | 키 소진/혼잡으로 **미뤄진 사용자만** 재시도 (무료 쿼터는 태평양시 자정 = 한국 16~17시에 리셋) |
| 월 23:05 | 마지막 실행 — 그래도 실패하면 조정 0 으로 기록 |
| 매일 04:00 | 만료 토큰·오래된 분석 기록 정리 |

서버를 여러 대 띄워도 PostgreSQL advisory lock + `UNIQUE(user_id, week_start)` 로 사용자당 한 번만 반영됩니다.

### 방법 B — 외부 cron
`ENABLE_SCHEDULER=false` 로 끄고 시스템 스케줄러에서 실행합니다.
```cron
CRON_TZ=Asia/Seoul
5 0 * * 1     cd /srv/diet/backend && npm run job:weekly:prod
5 1-22 * * 1  cd /srv/diet/backend && npm run job:weekly:prod
5 23 * * 1    cd /srv/diet/backend && npm run job:weekly:prod -- --final
```
Kubernetes 는 `CronJob` 에 `timeZone: Asia/Seoul`, `schedule: "5 0 * * 1"` 로 같은 명령을 실행하면 됩니다.

---

## 3. 핵심 설계

### 시간 규칙 (KST)
- DB 의 모든 시각은 `timestamptz`(UTC). "날짜"는 **서버가 Asia/Seoul 기준**으로 판단합니다.
- `meals.local_date` 는 서버가 계산해 저장하고, DB `CHECK (local_date = (eaten_at AT TIME ZONE 'Asia/Seoul')::date)` 로도 보장합니다.
- `GET /api/time` 이 오늘 KST 날짜를 제공하고, 프론트는 기기 시계 대신 서버 시각과의 차이를 보정해 씁니다.
- 모든 쓰기 API 는 본인 데이터 여부와 `local_date ≤ 오늘(KST)` 를 검증합니다 (미래 → 403).

### 영양 계산
- DB 에 100g당 매크로와 섭취 g 을 저장하고, 섭취 매크로·kcal 은 **GENERATED 컬럼**으로 자동 계산합니다.
  `kcal = 탄×4 + 단×4 + 지×9` (소수 첫째 자리). g 을 바꾸면 즉시 재계산됩니다.
- 앱(서버/프론트) 계산도 0.1 단위 정수 연산으로 DB 반올림과 **완전히 같은 값**을 냅니다 (부동소수점 오차 없음).
- g 이 없는 항목은 "g 입력 필요" 배지 + 일일 합계에서 제외(제외 개수 표시). `grams_source`(ai/user) 기록.

### 인증
- 비밀번호: 사용자별 16바이트 salt + **PBKDF2-HMAC-SHA256 600,000회**, 알고리즘/반복수/salt/해시 함께 저장, 상수시간 비교, 반복수 상향 시 로그인 때 자동 재해시.
- Access Token: JWT 15분, payload 는 `userId`, `tokenVersion` 만. 매 요청 tokenVersion 확인(모든 기기 로그아웃·비밀번호 변경 즉시 반영).
- Refresh Token: 랜덤 불투명 토큰 30일, DB 엔 SHA-256 해시만. httpOnly + Secure + SameSite=Strict 쿠키(`/api/auth` 경로 한정).
  사용할 때마다 rotation, **폐기된 토큰 재사용 시 같은 family 전체 폐기**. 탭 여러 개는 Web Locks 로 refresh 직렬화.
- 로그인 5회 연속 실패 → 15분 잠금(병렬 요청으로 우회 불가하도록 시도 횟수를 먼저 원자적으로 증가) + IP 레이트 리밋.
- 비밀번호 찾기: 계정 존재 여부와 무관하게 같은 응답, 임시 비밀번호(14자, 30분, 1회용, 이메일당 1시간 3회),
  기존 비밀번호도 유효, 임시 비밀번호 로그인 시 **비밀번호 변경 전용 제한 토큰**(별도 키로 서명)만 발급.

### 사진 처리 (임시 저장 → 결과만 저장 → 파기)
```
[휴대폰] 앱 내 카메라(무음) 또는 앨범 → 1024px/JPEG 0.8 리사이즈 (메모리에서만)
   │ POST /api/meals/analyze  (multipart, 10MB 제한)
[서버] 작업 접수 → 이미지를 작업별 랜덤 키로 AES-256-GCM 암호화해 임시 디렉터리에 저장 (키는 메모리에만)
   │ 워커가 Gemini 키 풀로 분석 (모든 키가 바쁘면 재업로드 없이 대기열에서 재시도)
   ▼ 끝나면(성공/실패/취소/만료) ① 파일 0 덮어쓰기+삭제, 키 폐기 ② 분석 결과(JSON)만 DB 저장
[DB] food_analysis_jobs: 결과·상태·이미지 지문(SHA-256)만. CHECK 로 "끝난 작업은 image_purged_at 필수"
```
- 보관 시간(기본 300초)을 넘긴 이미지는 상태와 무관하게 강제 파기, 서버 재시작 시 남은 파일(복호화 불가)도 정리.
- 같은 사진을 10분 안에 다시 올리면 기존 결과를 재사용(AI 호출 없음).
- 분석 화면을 닫거나 취소하면 서버 임시 이미지가 즉시 파기됩니다.
- 이미지는 로그·DB·브라우저 저장소 어디에도 남지 않습니다.

### 앱 내 무음 카메라 / 갤러리 미저장
- 휴대폰 기본 카메라 앱(`<input capture>`)은 셔터음(국내 기기 강제)·갤러리 저장이 기기 정책에 묶여 웹에서 끌 수 없습니다.
- 그래서 `getUserMedia` 로 카메라 **영상의 현재 프레임을 canvas 로 복사**합니다 → 셔터음 없음, 파일 저장 없음.
  촬영 직후 카메라를 끄고, 사진은 메모리 Blob 으로만 존재하다 분석이 끝나면 버려집니다.
- 카메라 권한 거부/미지원 시에만 앨범 선택 또는 기본 카메라 앱으로 대체합니다(이 경우 기기 설정에 따라 셔터음/저장 가능 — 화면에 안내).

### Gemini 키 풀 (무료 티어 여러 키 최대 활용)
`GEMINI_API_KEYS=k1,k2,k3`

| 기능 | 내용 |
|---|---|
| 부하 분산 | 동시 요청 수 → 분당 토큰(TPM) 사용률 → 분당 요청(RPM) 사용률 → 일일 사용률 → 평균 지연 → round-robin 순으로 키 선택 |
| TPM 예산 | 요청마다 입력 토큰을 추정해 **예약**하고 응답의 실제 `promptTokenCount` 로 정산 (요청 종류별 추정 오차도 학습). 이미지 요청이 몰려도 TPM 초과 전에 다른 키로 분산 |
| 한도 학습 | 한도를 모르면(0) 429 응답으로 RPM/TPM 한도를 학습해 이후 선제적으로 피함 (15분 후 재학습) |
| 429 구분 | `PerDay` → 다음 쿼터 리셋(태평양시 자정)까지 제외 / 토큰·분당 → `retryDelay` 만큼 쿨다운 |
| failover | 429·5xx·잘못된 키·네트워크 끊김 → **즉시 다른 키로** 재요청 (같은 키는 가능한 한 피함) |
| 끊김 방지 | `streamGenerateContent`(SSE) + `includeThoughts` 로 **추론 중에도 heartbeat** 수신 → 15초 무응답(정체)·`finishReason` 없는 종료·깨진 JSON 감지 시 다른 키로 처음부터 재요청 (Gemini 는 이어받기 미지원) |
| 잘림 대응 | `MAX_TOKENS` 면 다음 시도는 thinking LOW + 출력 한도 2배 |
| hedging | 사용자 요청이 8초 안에 첫 데이터가 없으면 다른 키로 병렬 요청, 먼저 끝난 응답 채택 후 나머지 취소 (일일 예산이 충분할 때만, 배치는 안 함) |
| 대기열 | 키가 모두 바쁘면 공정한 대기열(사용자 요청 우선)에서 대기, 대기열이 가득 차면 즉시 "잠시 후" 응답 |
| 회로 차단 | 같은 키 연속 3회 장애 → 60초 제외 |
| 배치 예약분 | 주간 배치는 일일 한도의 20% 를 사용자 사진 분석용으로 남김 |
| 영속화 | 키별(SHA-256 지문) 일일 사용량·소진 여부를 `gemini_key_usage` 에 저장 → 재시작해도 유지. 키 원문은 로그/DB 에 남지 않음 |

**권장 설정**: AI Studio 의 Rate limits 화면에서 사용하는 모델의 RPM/TPM/RPD 를 확인해
`GEMINI_RPM_PER_KEY`, `GEMINI_TPM_PER_KEY`, `GEMINI_RPD_PER_KEY` 에 넣으면 429 없이 미리 분산합니다.
요청 1건은 대략 시스템 프롬프트 ~2천 토큰 + 이미지 1,120 토큰(기본 해상도)입니다. TPM 이 병목이면
`GEMINI_MEDIA_RESOLUTION=MEDIA_RESOLUTION_MEDIUM` 으로 이미지 토큰을 절반(560)으로 줄일 수 있습니다(모델이 거부하면 자동 해제).

> **주의**
> - 무료 티어 한도는 **API 키가 아니라 Google Cloud 프로젝트 단위**입니다. 같은 프로젝트의 키를 여러 개 넣으면 한도는 늘지 않고 failover 용도로만 쓰입니다.
> - 여러 프로젝트/계정으로 무료 한도를 넘겨 쓰는 것은 Google API 약관의 사용량 제한 우회 금지 조항에 걸릴 수 있으니 약관을 확인하세요. 안정적으로 운영하려면 결제 연결(유료 티어) 키를 풀에 함께 넣는 것을 권장합니다.
> - 무료 티어로 보낸 이미지·프롬프트는 Google 의 제품 개선에 쓰일 수 있습니다. 실제 사용자 사진을 다루는 서비스라면 유료 티어를 쓰세요.
> - 기본 모델은 최신 Stable Flash 인 `gemini-3.8-flash` 입니다 (명세의 `gemini-3.5-flash` 는 deprecated 되어 교체). thinking level 은 low / medium / high 만 지원하며(minimal 미지원) 기본 설정은 medium 입니다. 다른 모델은 `GEMINI_MODEL` 로 바꿀 수 있습니다.
> - 새 모델이 추론 요약 옵션(`includeThoughts`)을 거부해 400 오류가 나면 `GEMINI_STREAM_THOUGHTS=false` 로 끄세요 (정체 감지는 첫 응답 대기 시간을 25초로 늘려 계속 동작합니다).

### 주간 칼로리 조정 안전장치 (AI 결과보다 우선)
1. 1회 조정 폭 ±250kcal 로 자름
2. 최소 목표: 여성 1,200 / 남성 1,500kcal 이상, 그리고 BMR 이상 (최소값이 폭 제한보다 우선)
3. 지난주 기록 누락 3일 이상 → ±100kcal 이내로 더 보수적으로 (프롬프트 규칙을 서버에서도 강제)
4. AI 실패 → 조정 0, 사유 기록 / 탄단지 비율이 유효하지 않으면 기존 비율 유지
5. 사용자는 이번 주 조정을 거부(이전 값 복원)할 수 있음

---

## 4. 테스트
```bash
cd backend && npm test     # 단위 테스트
cd frontend && npm test
```
주요 테스트
- **KST 날짜 경계**: 23:59:59 / 00:00, 연말·윤년, 주(월~일) 경계, `/api/time`, 미래 날짜 403
- **g 변경 재계산**: DB GENERATED 컬럼과 같은 반올림, g 미입력 항목 합계 제외
- **토큰 rotation / 재사용 탐지**: family 폐기, 다른 기기 영향 없음, 만료/위조 토큰
- **칼로리 조정 안전장치**: ±250, 성별·BMR 최소값, 기록 누락, AI 실패
- 키 풀(분산·RPM/TPM·429 종류·학습·대기열·영속화), 스트리밍 failover(정체·끊김·잘림·hedging), 임시 이미지 암호화/파기, 비밀번호/JWT

---

## 5. API 요약 (`/api`)
| 영역 | 엔드포인트 |
|---|---|
| time | `GET /time` |
| auth | `POST /auth/signup` `/login` `/refresh` `/logout` `/logout-all` `/password/forgot` `/password/change` |
| me | `GET /me`, `PUT /me/profile`, `PUT /me/macro-ratio`, `DELETE /me`(탈퇴) |
| calendar | `GET /calendar?month=YYYY-MM` |
| days | `GET /days/:date`, `PUT /days/:date/exercise`, `PUT /days/:date/weight` |
| meals | `POST /meals/analyze`(작업 접수) · `GET /meals/analyze/:jobId?wait=초`(long-poll) · `DELETE /meals/analyze/:jobId`(취소) · `POST /meals` · `PATCH /meals/:id` · `DELETE /meals/:id` · `POST /meals/:id/items` |
| meal-items | `PATCH /meal-items/:id`(g 수정 시 재계산), `DELETE /meal-items/:id` |
| stats | `GET /stats/weight?range=1w|1m|3m|all`, `GET /stats/weekly-calories`, `GET /stats/macro-ratio?range=week|1m|3m` |
| adjustments | `GET /adjustments`, `POST /adjustments/:id/reject` |

오류 응답 형식: `{ "error": { "code": "...", "message": "사용자에게 보여줄 문장" } }`

---

## 6. 명세 대비 참고 사항
- **이미지 처리**: 원 명세는 "메모리에서만 처리"였으나 요청에 따라 "분석 동안만 서버 임시 저장(암호화) → 결과만 저장 → 즉시 파기"로 바꿨습니다. DB·로그에는 여전히 이미지가 남지 않습니다.
- **리사이즈**: 긴 변 1280px → **1024px**(JPEG 0.8)로 낮춰 업로드 크기와 지연을 줄였습니다 (`frontend/src/lib/constants.ts`).
- **분석 API**: 동기 응답 대신 작업(job) + long-poll 방식입니다. Gemini 호출 1건의 제한 시간은 30초, 대기열 대기는 이미지 보관 시간(기본 5분) 안에서 이뤄집니다.
- 증량 목표의 초기 칼로리는 TDEE + 300kcal 로 정했습니다 (명세에 없던 부분).
- 회원 탈퇴는 모든 기록을 삭제하고, `users` 행은 이메일·닉네임·비밀번호를 무작위 값으로 덮어쓴 뒤 `deleted_at` 만 남깁니다(같은 이메일로 재가입 가능).
