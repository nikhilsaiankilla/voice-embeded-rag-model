// FILE: src/lib/chunking.ts
//
// Multiple chunking strategies, chosen per-segment based on the document's
// natural structure rather than one naive fixed-size splitter for
// everything:
//
//  - "fixed"           char-count windows with overlap. Used only as a
//                       safety-net fallback for degenerate text (huge
//                       run-on content with no sentence punctuation, e.g.
//                       minified code, OCR garbage, log dumps) where
//                       semantic chunking would otherwise produce one
//                       enormous chunk.
//  - "semantic"         groups whole sentences up to a target size, never
//                       splitting mid-sentence, with a small sentence-level
//                       overlap carried into the next chunk for context
//                       continuity across the boundary.
//  - "metadata-aware"   respects structural boundaries the source format
//                       already gives us — PDF pages, PPTX slides, XLSX
//                       sheets, DOCX paragraphs — and never merges content
//                       across those boundaries. Each resulting chunk keeps
//                       that structural info (page/slide/sheet number) as
//                       metadata, and large segments are further split
//                       using the row-aware (tabular) or semantic (prose)
//                       method as appropriate.

export interface DocumentSegment {
    text: string;
    // Structural metadata from extraction, when the source format has it.
    // Exactly one of these (or none, for flat text formats) will be set.
    page?: number;
    slide?: number;
    sheet?: string;
    paragraphIndex?: number;
    kind?: "prose" | "tabular";
}

export interface Chunk {
    text: string;
    metadata: {
        chunkStrategy: "fixed" | "semantic" | "metadata-aware";
        section?: string; // human-readable label, e.g. "Slide 3", "Page 2", "Sheet: Q1 Data"
        page?: number;
        slide?: number;
        sheet?: string;
    };
}

const TARGET_CHUNK_SIZE = 800;
const MAX_CHUNK_SIZE = 1200; // hard ceiling before we force a fixed-size fallback split
const SENTENCE_OVERLAP_COUNT = 1; // carry the last N sentences into the next chunk
const FIXED_CHUNK_SIZE = 800;
const FIXED_CHUNK_OVERLAP = 150;
const TABULAR_ROWS_PER_CHUNK = 25;

// sentence splitting
// Deliberately simple/fast rather than NLP-grade: splits on ./!/?/newline
// followed by whitespace, while avoiding splitting on common abbreviations
// (Mr., Dr., e.g., i.e., U.S., etc.) so sentences don't get chopped mid-title.
const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "eg", "ie",
    "inc", "ltd", "co", "u.s", "u.k", "no", "vol", "fig", "approx",
]);

function splitIntoSentences(text: string): string[] {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return [];

    const raw = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\u2018\u201c])/);
    const sentences: string[] = [];

    for (const piece of raw) {
        const trimmedPrev = sentences[sentences.length - 1];
        const lastWord = trimmedPrev
            ?.trim()
            .split(/\s+/)
            .pop()
            ?.replace(/[.!?]+$/, "")
            .toLowerCase();

        if (trimmedPrev && lastWord && ABBREVIATIONS.has(lastWord)) {
            // Likely a false sentence break after an abbreviation — merge
            // back into the previous sentence instead of starting a new one.
            sentences[sentences.length - 1] = `${trimmedPrev} ${piece}`;
        } else {
            sentences.push(piece);
        }
    }

    return sentences.filter((s) => s.trim().length > 0);
}

// strategy: fixed-size (fallback only)
function fixedSizeChunk(text: string, size = FIXED_CHUNK_SIZE, overlap = FIXED_CHUNK_OVERLAP): string[] {
    const clean = text.replace(/\s+/g, " ").trim();
    const chunks: string[] = [];

    let start = 0;
    while (start < clean.length) {
        const end = Math.min(start + size, clean.length);
        chunks.push(clean.slice(start, end));
        if (end === clean.length) break;
        start = end - overlap;
    }

    return chunks.filter((c) => c.length > 0);
}

// strategy: semantic (sentence-grouped)
function semanticChunk(text: string): string[] {
    const sentences = splitIntoSentences(text);
    if (sentences.length === 0) return [];

    // If a single "sentence" is itself absurdly long (no punctuation at all
    // across a huge block — code, logs, OCR noise), semantic grouping can't
    // help; fall back to fixed-size for that piece specifically.
    if (sentences.some((s) => s.length > MAX_CHUNK_SIZE)) {
        return fixedSizeChunk(text);
    }

    const chunks: string[] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];

        if (currentLen + sentence.length > TARGET_CHUNK_SIZE && current.length > 0) {
            chunks.push(current.join(" "));
            // Overlap: carry the last N sentences forward for context
            // continuity across the chunk boundary.
            const overlapSentences = current.slice(-SENTENCE_OVERLAP_COUNT);
            current = [...overlapSentences];
            currentLen = overlapSentences.join(" ").length;
        }

        current.push(sentence);
        currentLen += sentence.length + 1;
    }

    if (current.length > 0) chunks.push(current.join(" "));

    return chunks;
}

// strategy: metadata-aware / tabular (row-preserving)
// For CSV-like sheet text, chunk by row groups rather than raw character
// windows so a chunk never cuts a row in half, and repeats the header row
// in every chunk so each one is independently interpretable (important
// since these get embedded and retrieved individually).
function tabularChunk(csvText: string): string[] {
    const lines = csvText.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];

    const header = lines[0];
    const rows = lines.slice(1);

    if (rows.length === 0) return [header];

    const chunks: string[] = [];
    for (let i = 0; i < rows.length; i += TABULAR_ROWS_PER_CHUNK) {
        const rowGroup = rows.slice(i, i + TABULAR_ROWS_PER_CHUNK);
        chunks.push([header, ...rowGroup].join("\n"));
    }

    return chunks;
}

// dispatcher
function sectionLabel(segment: DocumentSegment): string | undefined {
    if (segment.page !== undefined) return `Page ${segment.page}`;
    if (segment.slide !== undefined) return `Slide ${segment.slide}`;
    if (segment.sheet !== undefined) return `Sheet: ${segment.sheet}`;
    if (segment.paragraphIndex !== undefined) return undefined; // too granular to label usefully
    return undefined;
}

export function chunkDocument(segments: DocumentSegment[]): Chunk[] {
    const chunks: Chunk[] = [];

    for (const segment of segments) {
        const isStructural =
            segment.page !== undefined || segment.slide !== undefined || segment.sheet !== undefined;
        const section = sectionLabel(segment);

        let pieces: string[];
        let strategy: Chunk["metadata"]["chunkStrategy"];

        if (segment.kind === "tabular" || segment.sheet !== undefined) {
            pieces = tabularChunk(segment.text);
            strategy = "metadata-aware";
        } else if (isStructural) {
            // Respect the structural boundary (page/slide) — never merge
            // across segments — but still split large segments internally
            // using sentence-aware grouping rather than raw char windows.
            pieces = segment.text.length > MAX_CHUNK_SIZE ? semanticChunk(segment.text) : [segment.text.trim()];
            strategy = "metadata-aware";
        } else {
            pieces = semanticChunk(segment.text);
            strategy =
                pieces.length > 0 && pieces.every((p) => p.length <= MAX_CHUNK_SIZE) ? "semantic" : "fixed";
        }

        for (const piece of pieces) {
            if (!piece.trim()) continue;
            chunks.push({
                text: piece.trim(),
                metadata: {
                    chunkStrategy: strategy,
                    section,
                    page: segment.page,
                    slide: segment.slide,
                    sheet: segment.sheet,
                },
            });
        }
    }

    return chunks;
}