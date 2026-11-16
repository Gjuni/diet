-- =============================================================================
-- 이미지 기반 다이어트 기록 웹앱 - PostgreSQL 스키마 (PostgreSQL 15+)
--
--  * 이 파일을 그대로 실행하면 DB 객체가 생성된다.
--  * 여러 번 실행해도 오류가 나지 않는다 (IF NOT EXISTS / CREATE OR REPLACE).
--  * 모든 시각은 timestamptz(UTC 저장), "날짜"는 KST(Asia/Seoul) 기준 date 컬럼.
--  * PK는 UUID(gen_random_uuid(), PostgreSQL 13+ 내장 함수).
--  * 이미지 데이터는 어떤 테이블에도 저장하지 않는다.
--    (분석 중에만 서버 임시 디렉터리에 암호화 보관 → 분석 직후 파기, DB 에는 분석 결과만)
--
--  실행 예) psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 공통: updated_at 자동 갱신 트리거 함수
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- users: 계정
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text        NOT NULL,
  password_hash       bytea       NOT NULL,
  password_salt       bytea       NOT NULL,
  password_algo       text        NOT NULL DEFAULT 'pbkdf2-sha256',
  password_iterations integer     NOT NULL,
  nickname            text        NOT NULL,
  token_version       integer     NOT NULL DEFAULT 0,
  failed_login_count  integer     NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key            UNIQUE (email),
  CONSTRAINT users_email_normalized     CHECK (email = lower(btrim(email))),
  CONSTRAINT users_email_format         CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  CONSTRAINT users_nickname_len         CHECK (char_length(btrim(nickname)) BETWEEN 1 AND 30),
  CONSTRAINT users_password_algo        CHECK (password_algo IN ('pbkdf2-sha256')),
  CONSTRAINT users_password_iterations  CHECK (password_iterations >= 600000),
  CONSTRAINT users_password_salt_len    CHECK (octet_length(password_salt) >= 16),
  CONSTRAINT users_password_hash_len    CHECK (octet_length(password_hash) >= 32),
  CONSTRAINT users_token_version        CHECK (token_version >= 0),
  CONSTRAINT users_failed_login_count   CHECK (failed_login_count >= 0)
);

CREATE OR REPLACE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- user_profiles: 목표 칼로리 계산용 프로필
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id             uuid         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sex                 text         NOT NULL,
  birth_date          date         NOT NULL,
  height_cm           numeric(4,1) NOT NULL,
  start_weight_kg     numeric(4,1) NOT NULL,
  goal_weight_kg      numeric(4,1) NOT NULL,
  activity_level      text         NOT NULL,
  goal_type           text         NOT NULL,
  target_kcal         integer      NOT NULL,
  target_carbs_pct    smallint     NOT NULL DEFAULT 40,
  target_protein_pct  smallint     NOT NULL DEFAULT 30,
  target_fat_pct      smallint     NOT NULL DEFAULT 30,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_sex            CHECK (sex IN ('male', 'female')),
  CONSTRAINT user_profiles_birth_date     CHECK (birth_date >= DATE '1900-01-01'),
  CONSTRAINT user_profiles_height         CHECK (height_cm BETWEEN 100 AND 250),
  CONSTRAINT user_profiles_start_weight   CHECK (start_weight_kg BETWEEN 20 AND 300),
  CONSTRAINT user_profiles_goal_weight    CHECK (goal_weight_kg BETWEEN 20 AND 300),
  CONSTRAINT user_profiles_activity_level CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  CONSTRAINT user_profiles_goal_type      CHECK (goal_type IN ('lose', 'maintain', 'gain')),
  CONSTRAINT user_profiles_target_kcal    CHECK (target_kcal BETWEEN 800 AND 6000),
  CONSTRAINT user_profiles_carbs_pct      CHECK (target_carbs_pct BETWEEN 5 AND 80),
  CONSTRAINT user_profiles_protein_pct    CHECK (target_protein_pct BETWEEN 5 AND 80),
  CONSTRAINT user_profiles_fat_pct        CHECK (target_fat_pct BETWEEN 5 AND 80),
  CONSTRAINT user_profiles_macro_sum      CHECK (target_carbs_pct + target_protein_pct + target_fat_pct = 100)
);

CREATE OR REPLACE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- refresh_tokens: 불투명 refresh token (원문 X, SHA-256 hex 해시만 저장)
--   family_id = 하나의 로그인 세션(기기). rotation 시 같은 family 로 이어진다.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text        NOT NULL,
  family_id       uuid        NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  replaced_by     uuid        REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent      text,
  ip              inet,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_hash_format    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT refresh_tokens_user_agent_len CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT refresh_tokens_revoked_reason CHECK (
    revoked_reason IS NULL OR revoked_reason IN
      ('rotated', 'logout', 'logout_all', 'reuse_detected', 'password_changed', 'account_deleted')),
  CONSTRAINT refresh_tokens_revoked_pair   CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT refresh_tokens_expiry         CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx      ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx     ON refresh_tokens (expires_at);

CREATE OR REPLACE TRIGGER trg_refresh_tokens_updated_at
  BEFORE UPDATE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- password_resets: 이메일 임시 비밀번호 (비밀번호와 같은 방식으로 해시)
--   30분 유효, 1회용. 새로 발급하면 이전 것은 invalidated_at 으로 무효화.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  temp_password_hash  bytea       NOT NULL,
  salt                bytea       NOT NULL,
  algo                text        NOT NULL DEFAULT 'pbkdf2-sha256',
  iterations          integer     NOT NULL,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  invalidated_at      timestamptz,
  request_ip          inet,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_resets_algo       CHECK (algo IN ('pbkdf2-sha256')),
  CONSTRAINT password_resets_iterations CHECK (iterations >= 600000),
  CONSTRAINT password_resets_salt_len   CHECK (octet_length(salt) >= 16),
  CONSTRAINT password_resets_hash_len   CHECK (octet_length(temp_password_hash) >= 32),
  CONSTRAINT password_resets_expiry     CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS password_resets_user_created_idx ON password_resets (user_id, created_at DESC);

CREATE OR REPLACE TRIGGER trg_password_resets_updated_at
  BEFORE UPDATE ON password_resets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- food_analysis_jobs: 사진 분석 작업
--   이미지는 분석하는 동안에만 서버 임시 디렉터리에 (작업별 키로) 암호화 저장하고,
--   분석이 끝나면 즉시 파기한 뒤 "분석 결과(result)"만 여기에 남긴다.
--   이미지 자체는 DB 에 절대 저장하지 않는다 (지문/크기/형식만).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS food_analysis_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date       date        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  image_sha256     text        NOT NULL,
  image_bytes      integer     NOT NULL,
  image_mime       text        NOT NULL,
  image_purged_at  timestamptz,
  result           jsonb,
  error_code       text,
  error_message    text,
  attempts         smallint    NOT NULL DEFAULT 0,
  model            text,
  api_key_id       text,
  tokens_in        integer,
  tokens_out       integer,
  latency_ms       integer,
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT food_analysis_jobs_status      CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired')),
  CONSTRAINT food_analysis_jobs_sha256      CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT food_analysis_jobs_bytes       CHECK (image_bytes > 0 AND image_bytes <= 10485760),
  CONSTRAINT food_analysis_jobs_mime        CHECK (image_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  CONSTRAINT food_analysis_jobs_result      CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CONSTRAINT food_analysis_jobs_result_obj  CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  -- 끝난 작업은 반드시 이미지가 파기되어 있어야 한다
  CONSTRAINT food_analysis_jobs_purged      CHECK (status IN ('queued', 'processing') OR image_purged_at IS NOT NULL),
  CONSTRAINT food_analysis_jobs_finished    CHECK (status IN ('queued', 'processing') OR finished_at IS NOT NULL),
  CONSTRAINT food_analysis_jobs_attempts    CHECK (attempts >= 0),
  CONSTRAINT food_analysis_jobs_expiry      CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS food_analysis_jobs_user_date_idx ON food_analysis_jobs (user_id, local_date);
CREATE INDEX IF NOT EXISTS food_analysis_jobs_user_sha_idx  ON food_analysis_jobs (user_id, image_sha256, created_at DESC);
CREATE INDEX IF NOT EXISTS food_analysis_jobs_active_idx    ON food_analysis_jobs (expires_at) WHERE status IN ('queued', 'processing');

CREATE OR REPLACE TRIGGER trg_food_analysis_jobs_updated_at
  BEFORE UPDATE ON food_analysis_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- meals: 식사 1회 (사진 1장 = 식사 1건, 그 아래 여러 음식)
--   local_date 는 서버가 KST 기준으로 계산해 저장하며, CHECK 로 eaten_at 과의 일치를 보장한다.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at    timestamptz NOT NULL,
  local_date  date        NOT NULL,
  meal_slot   text        NOT NULL,
  source      text        NOT NULL,
  analysis_job_id uuid    REFERENCES food_analysis_jobs(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meals_meal_slot      CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
  CONSTRAINT meals_source         CHECK (source IN ('ai', 'manual')),
  CONSTRAINT meals_local_date_kst CHECK (local_date = (eaten_at AT TIME ZONE 'Asia/Seoul')::date)
);

CREATE INDEX IF NOT EXISTS meals_user_local_date_idx ON meals (user_id, local_date);

CREATE OR REPLACE TRIGGER trg_meals_updated_at
  BEFORE UPDATE ON meals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- meal_items: 음식 1개. 100g당 매크로 + 섭취 g 저장, 실제 섭취량은 GENERATED 컬럼.
--   섭취 매크로 = round(g / 100 × 100g당 값, 1)
--   kcal        = 탄수화물 g × 4 + 단백질 g × 4 + 지방 g × 9 (반올림된 매크로 기준)
--   grams 가 NULL 이면 섭취량/kcal 도 NULL → 일일 합계(SUM)에서 자동 제외.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meal_items (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id           uuid         NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  position          smallint     NOT NULL DEFAULT 0,
  name              text         NOT NULL,
  category          text         NOT NULL,
  grams             numeric(6,1),
  grams_source      text,
  grams_confidence  text,
  carbs_per_100g    numeric(4,1) NOT NULL,
  protein_per_100g  numeric(4,1) NOT NULL,
  fat_per_100g      numeric(4,1) NOT NULL,
  note              text,
  carbs_g           numeric(7,1) GENERATED ALWAYS AS (round(grams * carbs_per_100g / 100, 1)) STORED,
  protein_g         numeric(7,1) GENERATED ALWAYS AS (round(grams * protein_per_100g / 100, 1)) STORED,
  fat_g             numeric(7,1) GENERATED ALWAYS AS (round(grams * fat_per_100g / 100, 1)) STORED,
  kcal              numeric(8,1) GENERATED ALWAYS AS (
                      round(grams * carbs_per_100g   / 100, 1) * 4
                    + round(grams * protein_per_100g / 100, 1) * 4
                    + round(grams * fat_per_100g     / 100, 1) * 9) STORED,
  ai_raw            jsonb,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT meal_items_name_len      CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT meal_items_category      CHECK (category IN
    ('한식', '중식', '일식', '양식', '분식', '아시안', '패스트푸드', '샐러드/건강식', '디저트/간식', '음료', '기타')),
  CONSTRAINT meal_items_grams_range   CHECK (grams IS NULL OR (grams > 0 AND grams <= 5000)),
  CONSTRAINT meal_items_grams_source  CHECK (grams_source IS NULL OR grams_source IN ('ai', 'user')),
  CONSTRAINT meal_items_grams_pair    CHECK ((grams IS NULL) = (grams_source IS NULL)),
  CONSTRAINT meal_items_confidence    CHECK (grams_confidence IS NULL OR grams_confidence IN ('high', 'medium', 'low')),
  CONSTRAINT meal_items_macro_nonneg  CHECK (carbs_per_100g >= 0 AND protein_per_100g >= 0 AND fat_per_100g >= 0),
  CONSTRAINT meal_items_macro_sum     CHECK (carbs_per_100g + protein_per_100g + fat_per_100g <= 100),
  CONSTRAINT meal_items_note_len      CHECK (note IS NULL OR char_length(note) <= 200),
  CONSTRAINT meal_items_ai_raw_object CHECK (ai_raw IS NULL OR jsonb_typeof(ai_raw) = 'object')
);

CREATE INDEX IF NOT EXISTS meal_items_meal_idx ON meal_items (meal_id, position);

CREATE OR REPLACE TRIGGER trg_meal_items_updated_at
  BEFORE UPDATE ON meal_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- daily_logs: 하루 단위 운동 여부 / 체중 (하루 1행, 다시 입력하면 덮어씀)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_logs (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date  date         NOT NULL,
  exercised   boolean      NOT NULL DEFAULT false,
  weight_kg   numeric(4,1),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT daily_logs_user_date_key UNIQUE (user_id, local_date),
  CONSTRAINT daily_logs_weight_range  CHECK (weight_kg IS NULL OR weight_kg BETWEEN 20 AND 300)
);

CREATE OR REPLACE TRIGGER trg_daily_logs_updated_at
  BEFORE UPDATE ON daily_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- weekly_calorie_adjustments: 주간 AI 칼로리 조정 이력 (사용자별 주 1건)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weekly_calorie_adjustments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start          date        NOT NULL,
  prev_target_kcal    integer     NOT NULL,
  adjustment_kcal     integer     NOT NULL,
  new_target_kcal     integer     NOT NULL,
  ai_adjustment_kcal  integer,
  prev_macro_ratio    jsonb,
  macro_ratio         jsonb       NOT NULL,
  reason              text        NOT NULL,
  confidence          text,
  status              text        NOT NULL DEFAULT 'applied',
  guard_notes         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error_code          text,
  ai_raw              jsonb,
  rejected_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_adj_user_week_key   UNIQUE (user_id, week_start),
  CONSTRAINT weekly_adj_week_is_monday  CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT weekly_adj_status          CHECK (status IN ('applied', 'rejected', 'failed')),
  CONSTRAINT weekly_adj_confidence      CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  CONSTRAINT weekly_adj_arithmetic      CHECK (new_target_kcal = prev_target_kcal + adjustment_kcal),
  CONSTRAINT weekly_adj_failed_is_zero  CHECK (status <> 'failed' OR adjustment_kcal = 0),
  CONSTRAINT weekly_adj_target_range    CHECK (new_target_kcal BETWEEN 800 AND 6000),
  CONSTRAINT weekly_adj_macro_ratio     CHECK (jsonb_typeof(macro_ratio) = 'object'),
  CONSTRAINT weekly_adj_rejected_pair   CHECK ((status = 'rejected') = (rejected_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS weekly_adj_user_week_idx ON weekly_calorie_adjustments (user_id, week_start DESC);

CREATE OR REPLACE TRIGGER trg_weekly_adj_updated_at
  BEFORE UPDATE ON weekly_calorie_adjustments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- ai_usage_logs: AI 호출 기록 (이미지/프롬프트 원문은 절대 저장하지 않음)
--   local_date(KST)로 "사용자당 하루 N회" 제한을 계산한다.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL,
  model       text        NOT NULL,
  api_key_id  text,
  local_date  date        NOT NULL,
  tokens_in   integer,
  tokens_out  integer,
  latency_ms  integer,
  attempts    smallint    NOT NULL DEFAULT 1,
  success     boolean     NOT NULL,
  error_code  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_logs_kind     CHECK (kind IN ('analyze', 'weekly')),
  CONSTRAINT ai_usage_logs_tokens   CHECK ((tokens_in IS NULL OR tokens_in >= 0) AND (tokens_out IS NULL OR tokens_out >= 0)),
  CONSTRAINT ai_usage_logs_latency  CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT ai_usage_logs_attempts CHECK (attempts BETWEEN 0 AND 10)
);

CREATE INDEX IF NOT EXISTS ai_usage_logs_user_kind_date_idx ON ai_usage_logs (user_id, kind, local_date);

CREATE OR REPLACE TRIGGER trg_ai_usage_logs_updated_at
  BEFORE UPDATE ON ai_usage_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- gemini_key_usage: Gemini API 키별 일일 사용량 (키 풀 rotation 용)
--   key_id     = API 키의 SHA-256 앞 12자리 (키 원문은 저장하지 않음)
--   usage_date = 쿼터 리셋 기준 날짜 (무료 티어: 태평양 시간 자정)
--   서버를 재시작해도 오늘 어느 키를 얼마나 썼는지 / 소진됐는지 복원한다.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gemini_key_usage (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              text        NOT NULL,
  usage_date          date        NOT NULL,
  requests            integer     NOT NULL DEFAULT 0,
  successes           integer     NOT NULL DEFAULT 0,
  rate_limited        integer     NOT NULL DEFAULT 0,
  failures            integer     NOT NULL DEFAULT 0,
  tokens_in           bigint      NOT NULL DEFAULT 0,
  tokens_out          bigint      NOT NULL DEFAULT 0,
  daily_exhausted_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gemini_key_usage_key_date_key UNIQUE (key_id, usage_date),
  CONSTRAINT gemini_key_usage_key_id       CHECK (key_id ~ '^[0-9a-f]{12}$'),
  CONSTRAINT gemini_key_usage_counts       CHECK (requests >= 0 AND successes >= 0 AND rate_limited >= 0 AND failures >= 0
                                                  AND tokens_in >= 0 AND tokens_out >= 0)
);

CREATE OR REPLACE TRIGGER trg_gemini_key_usage_updated_at
  BEFORE UPDATE ON gemini_key_usage FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 집계 뷰
-- -----------------------------------------------------------------------------

-- 일별 매크로/kcal 합계. g 미입력(grams IS NULL) 항목은 합계에서 빠지고 개수만 센다.
CREATE OR REPLACE VIEW v_daily_nutrition AS
SELECT
  m.user_id,
  m.local_date,
  count(DISTINCT m.id)                                   AS meal_count,
  count(mi.id)                                           AS item_count,
  count(mi.id) FILTER (WHERE mi.grams IS NULL)           AS items_missing_grams,
  coalesce(sum(mi.carbs_g), 0)::numeric(9,1)             AS carbs_g,
  coalesce(sum(mi.protein_g), 0)::numeric(9,1)           AS protein_g,
  coalesce(sum(mi.fat_g), 0)::numeric(9,1)               AS fat_g,
  coalesce(sum(mi.kcal), 0)::numeric(10,1)               AS kcal
FROM meals m
LEFT JOIN meal_items mi ON mi.meal_id = m.id
GROUP BY m.user_id, m.local_date;

-- 월별 운동 횟수 (month = 해당 월 1일)
CREATE OR REPLACE VIEW v_monthly_exercise AS
SELECT
  dl.user_id,
  date_trunc('month', dl.local_date::timestamp)::date    AS month,
  count(*) FILTER (WHERE dl.exercised)                   AS exercise_days
FROM daily_logs dl
GROUP BY dl.user_id, date_trunc('month', dl.local_date::timestamp)::date;
