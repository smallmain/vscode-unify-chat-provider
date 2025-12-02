/**
 * Test configuration
 * Reads API credentials from environment variables.
 *
 * Setup:
 * 1. Copy .env.example to .env
 * 2. Fill in your API credentials
 * 3. Run tests with: npm test
 *
 * Environment variables:
 * - TEST_API_BASE_URL: API endpoint URL
 * - TEST_API_KEY: API key for authentication
 * - TEST_API_MODEL: Model ID to use for testing
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env file if it exists
function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

export const TEST_API_CONFIG = {
  baseUrl: process.env.TEST_API_BASE_URL ?? '',
  apiKey: process.env.TEST_API_KEY ?? '',
  testModel: process.env.TEST_API_MODEL ?? '',
};
