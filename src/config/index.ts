import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';
// Models Groq has removed. A stale GROQ_MODEL env var pointing at one of these
// makes every LLM call fail, so fall back to the default instead.
const RETIRED_GROQ_MODELS = new Set(['llama-3.1-8b-instant', 'llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768']);

// Groq model ids include the provider prefix ("qwen/qwen3.8-27b"); without it the
// API answers model_not_found and every AI call fails. Add the prefix for known families.
const GROQ_MODEL_PREFIXES: Array<[RegExp, string]> = [
  [/^qwen/i, 'qwen/'],
  [/^gpt-oss/i, 'openai/'],
  [/^(llama-4|llama-guard|llama-prompt-guard)/i, 'meta-llama/'],
];

export function resolveGroqModel(requested: string | undefined): string {
  requested = requested?.trim();
  if (!requested) return DEFAULT_GROQ_MODEL;
  if (!requested.includes('/')) {
    const prefix = GROQ_MODEL_PREFIXES.find(([re]) => re.test(requested!))?.[1];
    if (prefix) {
      console.warn(`⚠  GROQ_MODEL=${requested} is missing its provider prefix - using ${prefix}${requested}. Update GROQ_MODEL.`);
      requested = prefix + requested;
    }
  }
  if (RETIRED_GROQ_MODELS.has(requested)) {
    console.warn(`⚠  GROQ_MODEL=${requested} has been retired by Groq - using ${DEFAULT_GROQ_MODEL}. Update GROQ_MODEL.`);
    return DEFAULT_GROQ_MODEL;
  }
  return requested;
}

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  newsdata: {
    apiKey: process.env.NEWSDATA_API_KEY,
    baseUrl: process.env.NEWSDATA_BASE_URL,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: resolveGroqModel(process.env.GROQ_MODEL),
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  features: {
    maxArticlesToFetch: parseInt(process.env.MAX_ARTICLES_TO_FETCH || '10', 10),
    summaryMaxLength: parseInt(process.env.SUMMARY_MAX_LENGTH || '150', 10),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  telegram: {
    accessToken: process.env.TELEGRAM_ACCESS_TOKEN || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voice: process.env.ELEVENLABS_VOICE || '',
  },
};

// Validate required environment variables
const requiredEnvVars = [
  'NEWSDATA_API_KEY',
  'GROQ_API_KEY',
  'DATABASE_URL',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

if (!process.env.CLERK_JWT_KEY && !process.env.CLERK_SECRET_KEY) {
  console.warn('⚠  CLERK_JWT_KEY / CLERK_SECRET_KEY not set - all authenticated requests will be rejected.');
}
// Warn if optional but recommended env vars are missing
