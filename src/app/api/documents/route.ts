// FILE: src/app/api/documents/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { documents } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { upsertChunks, type UpsertChunk } from "@/src/lib/pinecone";
import PDFParser from "pdf2json";

const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const EMBEDDING_MODEL = "text-embedding-3-small";

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

async function embedBatch(texts: string[]): Promise<number[][]> {
    const res = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
    });
    return res.data.map((d) => d.embedding);
}

// pdf2json is callback/event-based, so wrap it in a Promise.
// It gives text pre-split into pages -> texts -> runs (R), URI-encoded.
function parsePdfBuffer(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
        const parser = new PDFParser();

        parser.on("pdfParser_dataError", (errData: any) => {
            reject(errData?.parserError ?? errData);
        });

        parser.on("pdfParser_dataReady", (pdfData: any) => {
            try {
                const text = pdfData.Pages.map((page: any) =>
                    page.Texts.map((t: any) =>
                        t.R.map((r: any) => decodeURIComponent(r.T)).join("")
                    ).join(" ")
                ).join("\n\n");
                resolve(text);
            } catch (err) {
                reject(err);
            }
        });

        parser.parseBuffer(buffer);
    });
}

async function extractText(file: File): Promise<string> {
    const isPdf =
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (isPdf) {
        const buffer = Buffer.from(await file.arrayBuffer());
        return parsePdfBuffer(buffer);
    }

    return file.text();
}

export async function POST(req: NextRequest) {
    const db = await getDb();
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
        return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const text = await extractText(file);
    if (!text.trim()) {
        return NextResponse.json({ error: "file has no readable text" }, { status: 400 });
    }

    const [doc] = await db
        .insert(documents)
        .values({
            sourceName: file.name,
            sourceType: file.type || "text/plain",
        })
        .returning();

    const chunks = chunkText(text);
    if (chunks.length === 0) {
        return NextResponse.json({ error: "no chunks produced" }, { status: 400 });
    }

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

    await upsertChunks(NAMESPACE, upsertPayload);

    return NextResponse.json({
        document: doc,
        chunkCount: chunks.length,
    });
}