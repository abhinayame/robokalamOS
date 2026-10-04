import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'mysql://rk:rk_dev_pw@127.0.0.1:3306/rk_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      BCRYPT_COST: '4',
      CORS_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
      AISENSY_API_KEY: 'test-aisensy-key-0001',
      AISENSY_WEBHOOK_SECRET: 'test-webhook-secret-123456',
      COMMS_WORKER: 'false',
      ZOOM_ACCOUNT_ID: 'zoom-acct-test',
      ZOOM_CLIENT_ID: 'zoom-client-test',
      ZOOM_CLIENT_SECRET: 'zoom-secret-test-0001',
      ZOOM_WEBHOOK_SECRET_TOKEN: 'zoom-webhook-token-test',
      RAZORPAY_KEY_ID: 'rzp_test_keyid0001',
      RAZORPAY_KEY_SECRET: 'test-rzp-secret-0001',
      RAZORPAY_WEBHOOK_SECRET: 'test-rzp-webhook-secret',
    },
  },
});
