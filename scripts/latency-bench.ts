// FILE: scripts/latency-bench.ts
//
// Measures end-to-end retrieval-pipeline latency (query embedding +
// Pinecone similarity search) across a batch of test queries, and reports
// P50 / P70 / P100 as required by the assignment brief.
//
// This intentionally mirrors exactly what /api/chat/route.ts does on the
// hot path for a live query: embed the user's message, then query the
// vector DB. Chunking itself only happens once at upload time (in
// /api/documents/route.ts), so it isn't part of the per-query number the
// brief is asking about — but if you want it included anyway, see the
// optional CHUNK_SAMPLE_TEXT block below.
//
// Usage:
//   npx tsx scripts/latency-bench.ts
//
// Requires the same env vars as the app (.env.local is loaded automatically
// if you run via `next dev`-adjacent tooling, or pass them inline):
//   OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX, PINECONE_NAMESPACE

import "dotenv/config";
import { openai } from "../src/lib/openai";
import { querySimilar } from "../src/lib/pinecone";

const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const EMBEDDING_MODEL = "text-embedding-3-small";
const TOP_K = 5;

// Replace these with questions representative of your actual test corpus —
// mix of on-topic (should retrieve well) and off-topic (should score low,
// exercising the guardrail path) so your latency numbers reflect real usage,
// not just best-case queries.
const TEST_QUERIES: string[] = [
    "What programming languages does the candidate know?",
    "Summarize the candidate's most recent work experience.",
    "What is the candidate's educational background?",
    "Does the candidate have any machine learning project experience?",
    "What certifications does the candidate hold?",
    "List the candidate's key technical skills.",
    "What was the candidate's role in their most recent internship?",
    "Has the candidate worked with cloud platforms like AWS or GCP?",
    "What GPA or academic performance is mentioned?",
    "Summarize the candidate's leadership or extracurricular activities.",
    "What is the capital of France?", // deliberately off-topic control query
    "Explain quantum entanglement in simple terms.", // off-topic control
];

// Optional: measure raw chunking cost too (in-memory, no network) if you
// want a single script that reports both. Uses the same chunker as
// /api/documents/route.ts — keep this in sync if that function changes.
const CHUNK_SAMPLE_TEXT =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(400); // ~24k chars, roughly a multi-page resume/doc

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

function chunkText(text: string): string[] {
    const clean = text.replace(/\s+/g, " ").trim();
    const chunks: string[] = [];
    let start = 0;
    while (start < clean.length) {
        const end = Math.min(start + CHUNK_SIZE, clean.length);
        chunks.push(clean.slice(start, end));
        if (end === clean.length) break;
        start = end - CHUNK_OVERLAP;
    }
    return chunks.filter((c) => c.length > 0);
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarize(label: string, samples: number[]) {
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p70 = percentile(sorted, 70);
    const p100 = percentile(sorted, 100); // = max
    const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);

    console.log(`\n${label}`);
    console.log("-".repeat(label.length));
    console.log(`  samples : ${samples.length}`);
    console.log(`  avg     : ${avg}ms`);
    console.log(`  P50     : ${p50}ms`);
    console.log(`  P70     : ${p70}ms`);
    console.log(`  P100    : ${p100}ms  (max)`);
    console.log(`  target  : <200ms  ->  ${p50 < 200 ? "PASS (P50)" : "FAIL (P50)"}`);
}

async function main() {
    console.log(`Running latency benchmark against namespace "${NAMESPACE}"...`);
    console.log(`${TEST_QUERIES.length} test queries, 1 warmup run (excluded from stats)\n`);

    // warmup: first call often eats connection setup / cold-start cost
    const warmupEmbed = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: TEST_QUERIES[0],
    });
    await querySimilar(NAMESPACE, warmupEmbed.data[0].embedding, TOP_K);

    const embedTimes: number[] = [];
    const retrieveTimes: number[] = [];
    const totalTimes: number[] = [];

    for (const query of TEST_QUERIES) {
        const t0 = performance.now();

        const embedStart = performance.now();
        const embeddingRes = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: query,
        });
        const embedMs = performance.now() - embedStart;

        const retrieveStart = performance.now();
        const matches = await querySimilar(NAMESPACE, embeddingRes.data[0].embedding, TOP_K);
        const retrieveMs = performance.now() - retrieveStart;

        const totalMs = performance.now() - t0;

        embedTimes.push(embedMs);
        retrieveTimes.push(retrieveMs);
        totalTimes.push(totalMs);

        const topScore = matches[0]?.score?.toFixed(3) ?? "n/a";
        console.log(
            `  [${totalMs.toFixed(0).padStart(4)}ms] embed=${embedMs.toFixed(0)}ms retrieve=${retrieveMs.toFixed(0)}ms topScore=${topScore}  "${query.slice(0, 50)}${query.length > 50 ? "…" : ""}"`
        );
    }

    // --- optional: in-memory chunking cost, reported separately since it's
    // not part of the per-query hot path ---
    const chunkTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        chunkText(CHUNK_SAMPLE_TEXT);
        chunkTimes.push(performance.now() - start);
    }

    summarize("Query embedding (OpenAI text-embedding-3-small)", embedTimes);
    summarize("Vector DB retrieval (Pinecone query, top_k=5)", retrieveTimes);
    summarize("End-to-end retrieval pipeline (embed + retrieve)", totalTimes);
    summarize(`Chunking only (in-memory, ~${CHUNK_SAMPLE_TEXT.length} chars, 20 runs)`, chunkTimes);

    console.log("\nDone. Copy the P50/P70/P100 block above into your submission.\n");
}

main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});