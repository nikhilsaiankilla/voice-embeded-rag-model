// FILE: src/app/api/documents/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/src/db";
import { documents } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { upsertChunks, type UpsertChunk } from "@/src/lib/pinecone";
import PDFParser from "pdf2json";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const EMBEDDING_MODEL = "text-embedding-3-small";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

// chunking
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

// shared helpers
// pdf2json (and some XML text runs) percent-encode content, but real-world
// files often contain a bare "%" that isn't a valid escape (e.g. "100% off").
// decodeURIComponent throws URIError on that instead of degrading gracefully,
// which was crashing the whole upload. This sanitizes stray "%" first, and
// falls back to the raw string if it still can't be decoded.
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

// per-format extractors
function parsePdfBuffer(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
        const parser = new PDFParser();

        parser.on("pdfParser_dataError", (errData: any) => {
            reject(new Error(errData?.parserError?.message ?? "Failed to parse PDF"));
        });

        parser.on("pdfParser_dataReady", (pdfData: any) => {
            try {
                const text = (pdfData?.Pages ?? [])
                    .map((page: any) =>
                        (page?.Texts ?? [])
                            .map((t: any) =>
                                (t?.R ?? []).map((r: any) => safeDecodeURIComponent(r?.T ?? "")).join("")
                            )
                            .join(" ")
                    )
                    .join("\n\n");
                resolve(text);
            } catch (err) {
                reject(err);
            }
        });

        parser.parseBuffer(buffer);
    });
}

async function parseDocxBuffer(buffer: Buffer): Promise<string> {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
}

async function parsePptxBuffer(buffer: Buffer): Promise<string> {
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

    const slideTexts: string[] = [];
    for (const filename of slideFiles) {
        const xml = await zip.files[filename].async("string");
        const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
            decodeXmlEntities(m[1])
        );
        if (runs.length > 0) slideTexts.push(runs.join(" "));
    }

    return slideTexts.join("\n\n");
}

function parseSpreadsheetBuffer(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: "buffer" });

    return workbook.SheetNames.map((sheetName: any) => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        return `--- Sheet: ${sheetName} ---\n${csv}`;
    }).join("\n\n");
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ");
}

// dispatcher
type ExtractResult = { text: string; warning?: string };

async function extractText(file: File): Promise<ExtractResult> {
    const name = file.name.toLowerCase();
    const mime = file.type || "";
    const buffer = Buffer.from(await file.arrayBuffer());

    const isExt = (...exts: string[]) => exts.some((e) => name.endsWith(e));

    if (mime === "application/pdf" || isExt(".pdf")) {
        return { text: await parsePdfBuffer(buffer) };
    }

    if (
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        isExt(".docx")
    ) {
        return { text: await parseDocxBuffer(buffer) };
    }

    if (
        mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        isExt(".pptx")
    ) {
        return { text: await parsePptxBuffer(buffer) };
    }

    if (
        mime.includes("spreadsheet") ||
        isExt(".xlsx", ".xls", ".xlsm")
    ) {
        return { text: parseSpreadsheetBuffer(buffer) };
    }

    if (isExt(".csv", ".tsv")) {
        // Plain delimited text — read directly rather than via the xlsx
        // parser, which can mis-infer types on ambiguous CSV cells.
        return { text: buffer.toString("utf-8") };
    }

    if (isExt(".doc")) {
        throw new Error(
            "Legacy .doc files aren't supported — please save/export as .docx and re-upload."
        );
    }

    if (mime === "text/html" || isExt(".html", ".htm")) {
        return { text: stripHtml(buffer.toString("utf-8")) };
    }

    if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        isExt(".txt", ".md", ".markdown", ".json", ".rtf", ".log", ".yaml", ".yml")
    ) {
        return { text: buffer.toString("utf-8") };
    }

    // Last-resort fallback: try reading as UTF-8 text. If it looks like
    // binary garbage (lots of replacement/control chars), fail with a clear
    // "unsupported format" error instead of embedding noise.
    const asText = buffer.toString("utf-8");
    const controlCharRatio =
        (asText.match(/[\x00-\x08\x0E-\x1F\uFFFD]/g)?.length ?? 0) / Math.max(asText.length, 1);

    if (controlCharRatio > 0.02) {
        throw new Error(
            `Unsupported file type "${file.type || name.split(".").pop()}". Supported: pdf, docx, pptx, xlsx/xls, csv, txt, md, json, html.`
        );
    }

    return { text: asText, warning: "Parsed as plain text — format wasn't explicitly recognized." };
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
        extracted = await extractText(file);
    } catch (err: any) {
        console.error("Text extraction failed", { file: file.name, err });
        return NextResponse.json(
            { error: err?.message || `Failed to extract text from "${file.name}"` },
            { status: 422 }
        );
    }

    if (!extracted.text.trim()) {
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

    const chunks = chunkText(extracted.text);
    if (chunks.length === 0) {
        return NextResponse.json({ error: "no chunks produced" }, { status: 400 });
    }

    const EMBED_BATCH = 100;
    const upsertPayload: UpsertChunk[] = [];

    try {
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
    } catch (err: any) {
        console.error("Embedding/upsert failed", { file: file.name, err });
        return NextResponse.json(
            { error: `Failed to index "${file.name}": ${err?.message || "unknown error"}` },
            { status: 500 }
        );
    }

    return NextResponse.json({
        document: doc,
        chunkCount: chunks.length,
        warning: extracted.warning,
    });
}