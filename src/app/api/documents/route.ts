// FILE: src/app/api/documents/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { documents } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { upsertChunks, type UpsertChunk } from "@/src/lib/pinecone";

const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const EMBEDDING_MODEL = "text-embedding-3-small";

const CHUNK_SIZE = 800; // chars, ~approx 150-200 tokens
const CHUNK_OVERLAP = 150;

// Simple fixed-size chunking with overlap. Swap this out for the
// semantic/hierarchical strategy later — this just gets ingestion working
// end-to-end with the existing pinecone.ts helpers.
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

async function embedBatch(texts: string[]): Promise<number[][]> {
    const res = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
    });
    return res.data.map((d) => d.embedding);
}

export async function POST(req: NextRequest) {
    const db = await getDb();
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
        return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const text = await file.text();
    if (!text.trim()) {
        return NextResponse.json({ error: "file has no readable text" }, { status: 400 });
    }

    // Record the document
    const [doc] = await db
        .insert(documents)
        .values({
            sourceName: file.name,
            sourceType: file.type || "text/plain",
        })
        .returning();

    // Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) {
        return NextResponse.json({ error: "no chunks produced" }, { status: 400 });
    }

    // Embed in batches of 100 (OpenAI embeddings input limit headroom)
    const EMBED_BATCH = 100;
    const upsertPayload: UpsertChunk[] = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vectors = await embedBatch(batch);

        batch.forEach((chunkContent, j) => {
            const chunkIndex = i + j;
            upsertPayload.push({
                id: `${doc.id}_${chunkIndex}`,
                values: vectors[j],
                metadata: {
                    sourceId: doc.id,
                    botId: "default",
                    url: file.name,
                    text: chunkContent,
                    chunkIndex,
                },
            });
        });
    }

    // Store in Pinecone using the existing rate-limited upsert helper
    await upsertChunks(NAMESPACE, upsertPayload);

    return NextResponse.json({
        document: doc,
        chunkCount: chunks.length,
    });
}