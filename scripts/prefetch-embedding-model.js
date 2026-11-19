// Downloads the embedding model into ./models at build time, so a Render
// wake-up doesn't spend time (or fail) fetching it. Failure is not fatal:
// the backend downloads the model on first use instead.
const path = require('path');
(async () => {
  if (process.env.EMBEDDINGS_DISABLED === '1') return;
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.resolve(__dirname, '..', 'models');
    const fe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' });
    const out = await fe(['warm up'], { pooling: 'cls', normalize: true });
    console.log(`✅ embedding model ready in ./models (${out.dims.join('x')})`);
  } catch (err) {
    console.warn(`⚠ could not prefetch the embedding model (will download on first use): ${err.message}`);
  }
})();
