import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      ENABLE_SCHEDULER: 'false',
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-3.8-flash',
      GEMINI_THINKING_LEVEL: 'medium',
      AI_MOCK: 'false',
    },
  },
});
