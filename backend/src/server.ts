import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startScheduler } from './jobs/scheduler.js';
import { getAnalysisJobs } from './services/analysisJobs.js';
import { getKeyPool } from './services/gemini.js';

const app = createApp();
const keyPool = getKeyPool();
const jobs = getAnalysisJobs();

await jobs.start();

const server = app.listen(config.port, () => {
  console.info(`[server] http://localhost:${config.port} (env=${config.nodeEnv}, model=${config.gemini.model})`);
  if (config.gemini.mock) {
    console.warn('[server] AI_MOCK=true: Gemini 대신 고정 응답을 사용합니다 (개발용).');
  } else if (keyPool.size === 0) {
    console.warn('[server] GEMINI_API_KEYS 가 없어 사진 분석은 비활성화됩니다 (수동 입력만 가능).');
  } else {
    console.info(`[server] Gemini 키 ${keyPool.size}개: ${keyPool.status().map((s) => s.label).join(', ')}`);
  }
  console.info(`[server] 분석 임시 저장소: ${jobs.store.directory} (TTL ${config.analysis.imageTtlSec}초, 암호화)`);
});

if (config.enableScheduler) startScheduler();

function shutdown(signal: string) {
  console.info(`[server] ${signal} 수신, 종료합니다.`);
  server.close(() => {
    jobs
      .stop() // 남은 임시 이미지 즉시 파기
      .finally(() => pool.end().finally(() => process.exit(0)));
  });
  setTimeout(() => {
    void jobs.stop().finally(() => process.exit(1));
  }, 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
