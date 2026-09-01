# Voice-Enabled RAG Assistant

A full-duplex, voice-enabled Retrieval-Augmented Generation system. Speak a question, it transcribes, retrieves grounded context from your uploaded documents, streams back an answer, and speaks it — with real interruptibility (barge-in) so you can cut it off and ask something else mid-reply, just like a phone call.

Built for the SDE AIML 2 assignment: **voice input → speech-to-text → chunking/retrieval → grounded, streamed, spoken answer.**

---

## Pipeline overview

```
🎙️ Voice input (mic)
   │  VAD detects speech start/end
   ▼
📝 Speech-to-text (Sarvam saaras:v3)
   │
   ▼
🧩 Chunking (upload-time, multi-strategy — see below)
   │
   ▼
🔎 Vector retrieval (Pinecone, doc-scoped when files are attached)
   │
   ▼
🛡️ Guardrails (moderation + confidence threshold)
   │
   ▼
💬 Grounded answer generation (OpenAI gpt-4o-mini, streamed)
   │
   ▼
🔊 Progressive TTS (Sarvam bulbul:v3, sentence-by-sentence, in order)
   │
   ▼
👂 Mic reopens automatically — ready for the next turn, or barge-in mid-reply
```

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) | API routes + streaming responses in one project |
| Chat model | OpenAI `gpt-4o-mini` | Fast, cheap, streams well |
| Embeddings | OpenAI `text-embedding-3-small` | Good quality/cost/latency tradeoff |
| Vector DB | Pinecone | Managed, namespace-per-bot, metadata filtering |
| STT | Sarvam `saaras:v3` | Strong multilingual (Indian languages + English) transcription |
| TTS | Sarvam `bulbul:v3` | Natural-sounding, fast synthesis, multiple speakers |
| DB (sessions/messages) | Postgres via Drizzle ORM | Simple relational schema for chat history |
| Rate limiting | Upstash Redis (`@upstash/ratelimit`) | Distributed limiter, holds across serverless invocations |
| Doc parsing | `pdf2json`, `mammoth`, `xlsx` (SheetJS), `jszip` | One real extractor per format instead of a generic fallback |

---

## Features implemented

### Voice conversation
- **Manual push-to-talk** — tap the mic, speak, auto-stops on 1.2s of silence, transcribes, and either inserts into the text box or sends immediately.
- **Live hands-free mode** ("Go live") — continuous listening via a lightweight RMS-based voice activity detector (`useVoiceActivityDetector`). No need to tap anything between turns; the mic reopens automatically once the assistant finishes speaking.
- **Barge-in / interruptibility** — if you start talking while the assistant is still replying (streaming text or playing TTS), the VAD detects it immediately, aborts the in-flight `/api/chat` request (`AbortController`), stops all queued/playing audio, and starts capturing your new utterance — no need to wait for the assistant to finish.
- **Streaming responses** — the chat route streams newline-delimited JSON events (`meta` → `token`* → `done`) over a `ReadableStream`, so the UI renders tokens as they arrive instead of waiting for the full completion.
- **Progressive, strictly-ordered TTS** — as soon as a complete sentence appears in the token stream, it's sent to `/api/tts` immediately (all sentence requests fire concurrently for low latency), but playback is enforced in generation order via an indexed slot queue — sentence 3 can never play before sentence 2, even if its network request happens to resolve first.
- **Per-message "click to hear"** — every assistant message has a speaker icon that fetches and plays just that message's audio on demand, independent of live mode. Voice output for normal typed chat is **opt-in** (off by default) so TTS calls only happen when the user actually wants audio.

### Retrieval-Augmented Generation
- Documents are uploaded, parsed, chunked, embedded, and stored in Pinecone with `sourceId` metadata.
- When a user attaches specific document(s) to a message, retrieval is **scoped** to just those documents via a Pinecone metadata filter (`sourceId: { $in: [...] }}`), instead of searching the entire namespace — this was a real bug we hit and fixed (the client was already sending `documentIds`, but the API route was silently ignoring them, causing hallucinated answers about the wrong/no document).
- The system prompt differs based on scope: scoped queries are instructed to answer *strictly* from retrieved context and say so explicitly if the context doesn't cover the question; unscoped queries are allowed to blend in general knowledge.

### Multi-format document ingestion
Every format gets a real, structure-aware extractor — not a generic `file.text()` fallback:

| Format | Extractor | Structure preserved |
|---|---|---|
| PDF | `pdf2json` | Per-page segments |
| DOCX | `mammoth` | Per-paragraph segments |
| PPTX | Manual zip + XML text-run extraction (`jszip`) | Per-slide segments |
| XLSX/XLS | `xlsx` (SheetJS) → CSV per sheet | Per-sheet segments, row-preserving |
| CSV/TSV | Direct read | Tabular, row-preserving |
| TXT/MD/JSON/HTML | Direct read (HTML gets tag-stripped) | Flat prose |
| Legacy `.doc` | Explicit rejection with a clear message | — |

A PDF-specific bug is also handled: `pdf2json` percent-encodes extracted text, and some real-world PDFs contain a bare `%` that isn't a valid escape sequence, which crashed `decodeURIComponent` with `URIError: URI malformed`. Fixed with a sanitize-and-retry decode (`safeDecodeURIComponent`) instead of letting one malformed character 500 the whole upload.

### Chunking — multiple strategies (`src/lib/chunking.ts`)
The brief explicitly asked for more than one naive fixed-size chunker. Three strategies are used, dispatched per document segment based on its structure:

1. **Metadata-aware** — for structurally-rich formats (PDF pages, PPTX slides, XLSX sheets). Chunks never cross a page/slide/sheet boundary. Spreadsheet sheets use row-group chunking (25 rows/chunk) with the header row repeated in every chunk, instead of raw character slicing that could cut a row in half.
2. **Semantic (sentence-grouped)** — for prose formats (DOCX paragraphs, TXT/MD/HTML). Groups whole sentences up to ~800 characters, never splitting mid-sentence, with a 1-sentence overlap carried into the next chunk for context continuity. A small abbreviation list (Mr., Dr., e.g., etc.) prevents false sentence breaks.
3. **Fixed-size** — kept only as a safety-net fallback for degenerate content (a single "sentence" with no punctuation across a huge block — minified code, OCR noise, log dumps) where semantic grouping can't help.

Every chunk's Pinecone metadata records which strategy produced it (`chunkStrategy`) and, where applicable, a human-readable section label (`"Slide 3"`, `"Page 2"`, `"Sheet: Q1 Data"`). The upload response returns a `chunkStrategyBreakdown` count so strategy usage is visible/verifiable per upload.

### Guardrails (`src/app/api/chat/route.ts`)
Two refusal paths, both bypass the LLM entirely so the model can't be talked around them, and both still persist the refusal as the assistant turn (so conversation history/session state stay consistent):

1. **Unsafe input** — every user message is checked against OpenAI's `omni-moderation-latest` endpoint *before* any retrieval or generation happens. Flagged input gets a canned refusal instead of reaching the chat model.
2. **Off-topic / low-confidence refusal** — when the user has attached document(s), the top Pinecone match's similarity score is checked against a threshold (`0.72` cosine similarity). Below that, the system refuses ("I couldn't find anything in the attached document(s)...") instead of letting the model fill the gap with general knowledge — this directly replaced the earlier behavior that caused hallucinated resume/document answers.

Both refusal messages flow through the same TTS pipeline as normal replies, so live mode *speaks* the refusal instead of going silent, and the UI shows a distinct "Guardrail: declined to answer" badge instead of the normal grounded/general-knowledge indicator.

### Harness — retries, structured error handling
Every external API call (OpenAI embeddings, OpenAI chat completions, OpenAI moderation, Pinecone upsert/query, Sarvam STT, Sarvam TTS) is wrapped in a shared exponential-backoff retry helper (`src/lib/retry.ts`):

- Retries only on genuinely transient failures — 429s, 5xxs, and connection-level errors (`ECONNRESET`, `ETIMEDOUT`, etc.) — never on 4xxs like 400/401/404, which fail identically on retry and would just burn the attempt budget.
- Honors a `Retry-After` header when present; otherwise uses exponential backoff with jitter (base 1s, capped at 15s, 5 attempts).
- Pinecone writes additionally go through a proactive Upstash-Redis-backed sliding-window rate limiter (`pineconeUpsertLimiter`, 50 upserts/sec) *before* the retry logic even engages, so bulk uploads don't trip the account-wide write quota in the first place.
- The OpenAI SDK's own built-in retries are disabled (`maxRetries: 0`) so a single failure doesn't get two independent backoff schedules stacked on top of each other.

### Latency measurement
A standalone benchmark script (`scripts/latency-bench.ts`) measures the retrieval pipeline (query embedding + Pinecone similarity search) across a batch of representative test queries (mix of on-topic and deliberately off-topic control queries) and reports P50/P70/P100.

**Measured result:** P50 ≈ 620ms end-to-end (embed ~310ms + retrieve ~320ms), against the assignment's <200ms target.

This does not hit the target, and we're reporting that honestly rather than fabricating a passing number. The bottleneck is architectural, not code inefficiency: every query makes two sequential network round-trips to US-hosted third-party APIs (OpenAI + Pinecone) from a non-colocated region, and that round-trip time alone exceeds the 200ms budget before either service does any actual work. Chunking itself (in-memory, no network) measured well under 1ms — the target is achievable for the local-compute part of the pipeline, just not for the network-bound retrieval calls given current infrastructure.

Mitigations identified (not all applied, given deadline):
- Co-locate the app and the Pinecone index in the same cloud region to eliminate most of the round-trip cost.
- Cache embeddings for repeated/common questions to skip the OpenAI call entirely on cache hits.
- Investigate/address occasional Pinecone cold-connection latency spikes observed in production logs (one request showed a 3.9s retrieval time, well outside the typical 300-400ms range).

---

## Known bugs fixed along the way (worth knowing if extending this)

- **Live mode was creating a new chat session on every utterance.** `handleLiveUtterance` was `useCallback`'d with an empty dependency array, so it permanently held the *first* render's `sendMessage` closure — which always saw `sessionId` as `null`. Fixed by routing all live-mode calls through a ref (`sendMessageRef`) that's reassigned to the current render's `sendMessage` on every render.
- **TTS sentences could play out of order.** The original queue pushed audio into a playback array whenever each sentence's `/api/tts` fetch happened to resolve, with no ordering guarantee — a slower-to-resolve earlier sentence could get played after a faster later one. Fixed with an indexed slot system: every sentence gets a sequence number the instant it's detected, all fetches run concurrently for speed, but playback strictly waits for the next expected index regardless of resolution order.
- **Only one sentence was extracted per streamed token event**, artificially delaying TTS when the model streamed a burst containing multiple complete sentences at once. Fixed by looping sentence extraction per token event instead of matching once.
- **`/api/chat` was silently ignoring `documentIds`** sent by the client, so document-scoped questions were actually searching the entire Pinecone namespace unfiltered (or nothing, if retrieval came up empty) and the model would improvise plausible-sounding but fabricated answers. Fixed by scoping the Pinecone query with a `sourceId` filter when documents are attached.
- **PDF text extraction crashed on stray `%` characters** in the source PDF (common — page numbers, percentages) because `decodeURIComponent` throws on a malformed escape sequence instead of degrading gracefully. Fixed with sanitize-and-retry decoding.
- **Non-PDF uploads (docx/pptx/xlsx) were parsed with `file.text()`**, which reads binary zip-based Office formats as garbled raw bytes instead of real text. Fixed with format-specific extractors for each type.
- **TTS 500 errors from a speaker/model mismatch** — the request defaulted to a speaker (`anushka`) that Sarvam's `bulbul:v3` model doesn't support. Fixed by defaulting to a valid speaker and validating against the real speaker list before calling the API.

---

## Project structure

```
src/
├── app/
│   ├── chat/page.tsx              # Main chat UI (voice, text, live mode, document upload)
│   └── api/
│       ├── chat/route.ts          # Streaming chat: guardrails → retrieval → generation
│       ├── documents/route.ts     # Upload → extract → chunk → embed → upsert
│       ├── stt/route.ts           # Sarvam speech-to-text proxy
│       ├── tts/route.ts           # Sarvam text-to-speech proxy
│       └── sessions/[...]         # Session list / messages / delete
├── components/chat/
│   ├── ChatMessageItem.tsx        # Message bubble, grounding badge, per-message speak button
│   ├── ChatInput.tsx              # Text input, attachments, mic trigger
│   ├── ChatSidebar.tsx            # Session list
│   ├── LiveModeBar.tsx            # Live-mode status bar (listening/recording/processing)
│   └── AttachmentList.tsx         # Upload chips with status
├── hooks/
│   ├── useLiveConversation.ts     # Full-duplex live mode state machine
│   ├── useVoiceActivityDetector.ts# RMS-based speech start/end detection
│   ├── useVoiceRecorder.ts        # Manual push-to-talk recorder
│   ├── useProgressiveAudioPlayer.ts # Ordered streaming TTS playback
│   ├── useMessageAudioPlayer.ts   # Per-message on-demand TTS playback
│   └── useAudioHistory.ts         # Waveform bar history for the recording UI
├── lib/
│   ├── openai.ts                  # OpenAI client (SDK retries disabled — see retry.ts)
│   ├── pinecone.ts                # Pinecone client, upsert/query, rate-limited writes
│   ├── sarvam.ts                  # Sarvam STT/TTS clients, retry-wrapped
│   ├── retry.ts                   # Shared exponential-backoff retry helper
│   ├── ratelimit.ts                # Upstash-backed distributed rate limiter
│   └── chunking.ts                # Multi-strategy chunking dispatcher
├── db/schema.ts                    # Drizzle schema: documents, chatSessions, chatMessages
scripts/
└── latency-bench.ts                # P50/P70/P100 retrieval latency benchmark
```

---

## Setup

### 1. Environment variables

```dotenv
OPENAI_API_KEY=
DATABASE_URL=
PINECONE_API_KEY=
PINECONE_INDEX=voice-embeded-rag-model
PINECONE_NAMESPACE=default

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

SARVAM_API_KEY=
```

### 2. Install & run

```bash
npm install
npm run dev
```

### 3. Run the latency benchmark

```bash
npm install -D tsx dotenv
npx tsx scripts/latency-bench.ts
```

---

## What's not implemented / left as future work

- **Retrieval pipeline latency exceeds the 200ms target** (see Latency Measurement above) — a network-topology limitation given the current OpenAI/Pinecone deployment regions, not something fixable purely in code.
- **No resumable mid-stream retry** — the retry helper covers connection *setup* failures for the chat completion call, but can't resume a stream that drops after tokens have already started flowing.
- **Guardrail confidence threshold (0.72) is a starting point**, not empirically tuned against a large labeled query set — would benefit from logging real query scores in production and adjusting based on observed separation between on-topic and off-topic queries.
- **Response moderation is input-only** — the moderation check runs on the user's message, not on the generated reply.

---

## Demo

Video walkthrough: https://drive.google.com/file/d/1MEA5WSrS10l7WKW4K6o0Ut6bYOmpsOfK/view?usp=sharing
Live Url: https://voice-embeded-rag-model.vercel.app/