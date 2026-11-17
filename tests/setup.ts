// Dummy values so modules that validate env vars at import time can load.
// Nothing in the test suite talks to these services.
process.env.NEWSDATA_API_KEY ??= 'test-newsdata-key';
process.env.NEWSDATA_BASE_URL ??= 'https://newsdata.invalid/api/1';
process.env.GROQ_API_KEY ??= 'test-groq-key';
process.env.DATABASE_URL ??= 'file::memory:';
process.env.DATABASE_AUTH_TOKEN ??= 'test-db-token';
process.env.HUGGING_FACE_API_KEY ??= 'test-hf-key';
