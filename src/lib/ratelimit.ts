// FILE: src/ratelimit.ts
// Shared rate limiters for external API calls (Upstash Redis-backed,
// so limits hold across serverless/distributed invocations).
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Pinecone write limiter — 50 upserts/sec window, shared across all
// distributed tasks so no single job can blow the account-wide write quota.
export const pineconeUpsertLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(50, '1 s'),
    prefix: 'ratelimit:pinecone:upsert',
    analytics: false,
});