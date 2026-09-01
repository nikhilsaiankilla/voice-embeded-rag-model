// FILE: src/lib/pinecone.ts
// Pinecone client + upsert + similarity search helpers.
// One index, namespaced per bot (bot.namespace from DB).
import { Pinecone, type RecordMetadata } from '@pinecone-database/pinecone';
import { pineconeUpsertLimiter } from './ratelimit';
import { getErrorStatus, withRetry, getRetryAfterMs } from './retry';

// Client (singleton)
let _client: Pinecone | null = null;

export function getPinecone(): Pinecone {
    if (!_client) {
        _client = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY!,
        });
    }
    return _client;
}

export function getIndex() {
    return getPinecone().index(process.env.PINECONE_INDEX!);
}

// Types
export interface ChunkMetadata extends RecordMetadata {
    sourceId: string;
    botId: string;
    url: string;
    text: string;
    chunkIndex: number;
}

export interface UpsertChunk {
    id: string;
    values: number[];
    metadata: ChunkMetadata;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Local backoff for 429s that slip past the rate-limit gate. Separate from
// trigger.dev's task-level retry (3 attempts in trigger.config.ts) — that
// retry is for genuine failures, not transient rate limits that clear in
// seconds. Burning a whole scrape-page attempt on a Pinecone 429 wastes the
// scrape + chunk + embed work just to retry the upsert.
const MAX_BACKOFF_ATTEMPTS = 5;

async function upsertWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for a slot from the shared limiter before calling Pinecone at all.
    for (let waitAttempt = 0; waitAttempt < 30; waitAttempt++) {
        const { success, reset } =
            await pineconeUpsertLimiter.limit('pinecone-upsert');
        if (success) break;
        const waitMs = Math.max(reset - Date.now(), 250);
        await sleep(waitMs);
    }

    // Local retry for 429s that still slip through (limiter is proactive,
    // not a hard guarantee). +1 because withRetry's maxAttempts counts the
    // first try; the original loop allowed 5 retries after it.
    return withRetry(fn, {
        maxAttempts: MAX_BACKOFF_ATTEMPTS + 1,
        isRetryable: (err) => getErrorStatus(err) === 429,
        getRetryAfterMs,
    });
}

// Upsert
// Batches in groups of 100 (Pinecone limit per request), gated behind the
// shared account-wide write-rate limiter.
export async function upsertChunks(
    namespace: string,
    chunks: UpsertChunk[],
): Promise<void> {
    const index = getIndex().namespace(namespace);
    const BATCH = 100;

    for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        await upsertWithRateLimit(() =>
            index.upsert({
                records: batch.map((c) => ({
                    id: c.id,
                    values: c.values,
                    metadata: c.metadata,
                })),
            }),
        );
    }
}

// Delete by source
// Called before re-sync so stale vectors don't linger.
export async function deleteSourceVectors(namespace: string, sourceId: string) {
    const pineconeIndex = getIndex();
    const ns = pineconeIndex.namespace(namespace);
    let paginationToken: string | undefined;

    do {
        const page = await ns.listPaginated({
            prefix: `${sourceId}_`,
            paginationToken,
        });

        const ids =
            page.vectors?.map((v) => v.id).filter((id): id is string => !!id) ?? [];
        if (ids.length > 0) {
            await ns.deleteMany(ids);
        }

        paginationToken = page.pagination?.next;
    } while (paginationToken);
}

// Query
export async function querySimilar(
    namespace: string,
    vector: number[],
    topK: number,
    filter?: Record<string, unknown>
) {
    const index = getIndex().namespace(namespace);

    const result = await index.query({
        vector,
        topK,
        includeMetadata: true,
        ...(filter ? { filter } : {}),
    });

    return (result.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score,
        text: (m.metadata?.text as string) ?? "",
        sourceId: (m.metadata?.sourceId as string) ?? "",
        url: (m.metadata?.url as string) ?? "",
    }));
}

export interface TopicHint {
    heading: string | null; // metadata.title / metadata.heading, if you have it
    snippet: string; // short — NOT full chunk text
    sourceId: string; // used for dedupe — one topic per source page/doc
}

// Broader, shallower query purely for follow-up topic breadth.
// Higher topK, no strict similarity floor — we want spread, not precision.
export async function querySimilarBroad(
    namespace: string,
    vector: number[],
    topK = 12,
): Promise<TopicHint[]> {
    const index = getIndex().namespace(namespace);
    const results = await index.query({
        vector,
        topK,
        includeMetadata: true,
    });

    // De-dupe by sourceId (one entry per page/doc), not by chunk id or
    // heading — your metadata doesn't carry a heading field yet, and
    // deduping by match.id let every chunk through even when the text
    // was identical (same page split into multiple chunks).
    const seen = new Set<string>();
    const hints: TopicHint[] = [];

    for (const match of results.matches ?? []) {
        const sourceId = (match.metadata?.sourceId as string) ?? match.id;

        if (seen.has(sourceId)) continue;
        seen.add(sourceId);

        const heading =
            (match.metadata?.heading as string) ??
            (match.metadata?.title as string) ??
            null;

        hints.push({
            heading,
            // truncate hard — this block should stay tiny, it's a topic map,
            // not a source of facts
            snippet: ((match.metadata?.text as string) ?? '').slice(0, 120),
            sourceId,
        });
    }

    return hints;
}