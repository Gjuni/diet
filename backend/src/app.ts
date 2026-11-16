import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimits.js';
import { adjustmentsRouter } from './routes/adjustments.js';
import { authRouter } from './routes/auth.js';
import { calendarRouter } from './routes/calendar.js';
import { daysRouter } from './routes/days.js';
import { mealItemsRouter, mealsRouter } from './routes/meals.js';
import { meRouter } from './routes/me.js';
import { statsRouter } from './routes/stats.js';
import { timeRouter } from './routes/time.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  if (config.corsOrigins.length > 0) {
    // 프론트엔드를 다른 출처에서 서빙할 때만 사용 (같은 사이트여야 SameSite=Strict 쿠키가 전송된다)
    app.use(cors({ origin: config.corsOrigins, credentials: true }));
  }
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // 간단한 접근 로그: 메서드/경로/상태/시간만. 본문·쿼리·파일은 남기지 않는다.
  if (!config.isTest) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on('finish', () => {
        console.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
      });
      next();
    });
  }

  app.get('/healthz', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use('/time', timeRouter);
  api.use('/auth', authRouter);
  api.use('/me', meRouter);
  api.use('/calendar', calendarRouter);
  api.use('/days', daysRouter);
  api.use('/meals', mealsRouter);
  api.use('/meal-items', mealItemsRouter);
  api.use('/stats', statsRouter);
  api.use('/adjustments', adjustmentsRouter);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
