// FILE: src/app/api/documents/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { documents } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { upsertChunks, type UpsertChunk } from "@/src/lib/pinecone";
import { chunkDocument, type DocumentSegment } from "@/src/lib/chunking";
import PDFParser from "pdf2json";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const EMBEDDING_MODEL = "text-embedding-3-small";

// shared helpers
function safeDecodeURIComponent(input: string): string {
    if (!input) return input;
    try {
        return decodeURIComponent(input);
    } catch {
        try {
            const sanitized = input.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
            return decodeURIComponent(sanitized);
        } catch {
            return input;
        }
    }
}

function decodeXmlEntities(input: string): string {
    return input
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ");
}

async function embedBatch(texts: string[]): Promise<number[][]> {
    const res = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
    });
    return res.data.map((d) => d.embedding);
}

// per-format extractors — now return structured segments
function parsePdfBuffer(buffer: Buffer): Promise<DocumentSegment[]> {
    return new Promise((resolve, reject) => {
        const parser = new PDFParser();

        parser.on("pdfParser_dataError", (errData: any) => {
            reject(new Error(errData?.parserError?.message ?? "Failed to parse PDF"));
        });

        parser.on("pdfParser_dataReady", (pdfData: any) => {
            try {
                const segments: DocumentSegment[] = (pdfData?.Pages ?? []).map((page: any, i: number) => {
                    const text = (page?.Texts ?? [])
                        .map((t: any) =>
                            (t?.R ?? []).map((r: any) => safeDecodeURIComponent(r?.T ?? "")).join("")
                        )
                        .join(" ");
                    return { text, page: i + 1, kind: "prose" as const };
                });
                resolve(segments.filter((s) => s.text.trim().length > 0));
            } catch (err) {
                reject(err);
            }
        });

        parser.parseBuffer(buffer);
    });
}

async function parseDocxBuffer(buffer: Buffer): Promise<DocumentSegment[]> {
    const { value } = await mammoth.extractRawText({ buffer });
    // mammoth's raw text separates paragraphs with newlines — group into
    // paragraph-level segments so chunking can respect paragraph boundaries
    // rather than treating the whole doc as one prose blob.
    const paragraphs = value
        .split(/\n{1,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    return paragraphs.map((text, i) => ({ text, paragraphIndex: i, kind: "prose" as const }));
}

async function parsePptxBuffer(buffer: Buffer): Promise<DocumentSegment[]> {
    const zip = await JSZip.loadAsync(buffer);

    const slideFiles = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
            const na = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
            const nb = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
            return na - nb;
        });

    if (slideFiles.length === 0) {
        throw new Error("No slides found in .pptx file");
    }

    const segments: DocumentSegment[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async("string");
        const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
            decodeXmlEntities(m[1])
        );
        const text = runs.join(" ").trim();
        if (text) segments.push({ text, slide: i + 1, kind: "prose" });
    }

    return segments;
}

function parseSpreadsheetBuffer(buffer: Buffer): DocumentSegment[] {
    const workbook = XLSX.read(buffer, { type: "buffer" });

    return workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        return { text: csv, sheet: sheetName, kind: "tabular" as const };
    }).filter((s) => s.text.trim().length > 0);
}

// dispatcher
type ExtractResult = { segments: DocumentSegment[]; warning?: string };

async function extractSegments(file: File): Promise<ExtractResult> {
    const name = file.name.toLowerCase();
    const mime = file.type || "";
    const buffer = Buffer.from(await file.arrayBuffer());

    const isExt = (...exts: string[]) => exts.some((e) => name.endsWith(e));

    if (mime === "application/pdf" || isExt(".pdf")) {
        return { segments: await parsePdfBuffer(buffer) };
    }

    if (
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        isExt(".docx")
    ) {
        return { segments: await parseDocxBuffer(buffer) };
    }

    if (
        mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        isExt(".pptx")
    ) {
        return { segments: await parsePptxBuffer(buffer) };
    }

    if (mime.includes("spreadsheet") || isExt(".xlsx", ".xls", ".xlsm")) {
        return { segments: parseSpreadsheetBuffer(buffer) };
    }

    if (isExt(".csv", ".tsv")) {
        return { segments: [{ text: buffer.toString("utf-8"), kind: "tabular" }] };
    }

    if (isExt(".doc")) {
        throw new Error(
            "Legacy .doc files aren't supported — please save/export as .docx and re-upload."
        );
    }

    if (mime === "text/html" || isExt(".html", ".htm")) {
        return { segments: [{ text: stripHtml(buffer.toString("utf-8")), kind: "prose" }] };
    }

    if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        isExt(".txt", ".md", ".markdown", ".json", ".rtf", ".log", ".yaml", ".yml")
    ) {
        return { segments: [{ text: buffer.toString("utf-8"), kind: "prose" }] };
    }

    const asText = buffer.toString("utf-8");
    const controlCharRatio =
        (asText.match(/[\x00-\x08\x0E-\x1F\uFFFD]/g)?.length ?? 0) / Math.max(asText.length, 1);

    if (controlCharRatio > 0.02) {
        throw new Error(
            `Unsupported file type "${file.type || name.split(".").pop()}". Supported: pdf, docx, pptx, xlsx/xls, csv, txt, md, json, html.`
        );
    }

    return {
        segments: [{ text: asText, kind: "prose" }],
        warning: "Parsed as plain text — format wasn't explicitly recognized.",
    };
}

// route
export async function POST(req: NextRequest) {
    const db = await getDb();
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
        return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    let extracted: ExtractResult;
    try {
        extracted = await extractSegments(file);
    } catch (err: any) {
        console.error("Text extraction failed", { file: file.name, err });
        return NextResponse.json(
            { error: err?.message || `Failed to extract text from "${file.name}"` },
            { status: 422 }
        );
    }

    const hasText = extracted.segments.some((s) => s.text.trim().length > 0);
    if (!hasText) {
        return NextResponse.json(
            { error: `"${file.name}" has no readable/extractable text (it may be a scanned image without OCR).` },
            { status: 400 }
        );
    }

    const [doc] = await db
        .insert(documents)
        .values({
            sourceName: file.name,
            sourceType: file.type || "text/plain",
        })
        .returning();

    // Dispatch to the right chunking strategy per segment: metadata-aware
    // for structured formats (PDF pages, PPTX slides, XLSX sheets),
    // semantic sentence-grouping for prose, fixed-size only as a fallback
    // for degenerate content. See src/lib/chunking.ts for details.
    const chunks = chunkDocument(extracted.segments);
    if (chunks.length === 0) {
        return NextResponse.json({ error: "no chunks produced" }, { status: 400 });
    }

    const EMBED_BATCH = 100;
    const upsertPayload: UpsertChunk[] = [];

    try {
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            const batch = chunks.slice(i, i + EMBED_BATCH);
            const vectors = await embedBatch(batch.map((c) => c.text));

            batch.forEach((chunk, j) => {
                const chunkIndex = i + j;
                upsertPayload.push({
                    id: `${doc.id}_${chunkIndex}`,
                    values: vectors[j],
                    metadata: {
                        sourceId: doc.id,
                        botId: "default",
                        url: file.name,
                        text: chunk.text,
                        chunkIndex,
                        chunkStrategy: chunk.metadata.chunkStrategy,
                        ...(chunk.metadata.section ? { section: chunk.metadata.section } : {}),
                        ...(chunk.metadata.page !== undefined ? { page: chunk.metadata.page } : {}),
                        ...(chunk.metadata.slide !== undefined ? { slide: chunk.metadata.slide } : {}),
                        ...(chunk.metadata.sheet !== undefined ? { sheet: chunk.metadata.sheet } : {}),
                    },
                });
            });
        }

        await upsertChunks(NAMESPACE, upsertPayload);
    } catch (err: any) {
        console.error("Embedding/upsert failed", { file: file.name, err });
        return NextResponse.json(
            { error: `Failed to index "${file.name}": ${err?.message || "unknown error"}` },
            { status: 500 }
        );
    }

    // Small summary of strategy usage — useful for your submission writeup
    // and for sanity-checking that structured formats actually took the
    // metadata-aware path rather than falling through to semantic/fixed.
    const strategyCounts = chunks.reduce<Record<string, number>>((acc, c) => {
        acc[c.metadata.chunkStrategy] = (acc[c.metadata.chunkStrategy] ?? 0) + 1;
        return acc;
    }, {});

    return NextResponse.json({
        document: doc,
        chunkCount: chunks.length,
        chunkStrategyBreakdown: strategyCounts,
        warning: extracted.warning,
    });
}