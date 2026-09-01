import OpenAI from 'openai'

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // We wrap every call ourselves with retry.ts (matches Pinecone's and
    // Sarvam's backoff). Disable the SDK's own default retries (maxRetries: 2)
    // so a 429 doesn't get two independent backoff schedules stacked on it.
    maxRetries: 0,
});