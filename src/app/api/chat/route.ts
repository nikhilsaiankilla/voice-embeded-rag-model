// FILE: src/app/api/chat/route.ts
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { querySimilar } from "@/src/lib/pinecone";
import { getRetryAfterMs, isRetryableError, withRetry } from "@/src/lib/retry";

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";
const MODERATION_MODEL = "omni-moderation-latest";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const HISTORY_LIMIT = 20;
const TOP_K = 5;
const TOP_K_SCOPED_PER_DOC = 8;
const TOP_K_SCOPED_MAX = 24;

const timers = () => {
    const marks: Record<string, number> = {};
    return {
        start: (label: string) => { marks[label] = performance.now(); },
        end: (label: string) => Math.round(performance.now() - marks[label]),
    };
};

// Guardrail 2 thresholds — see the note above isLowConfidence below for why
// scoped and fallback matches use different bars.
const SCOPED_MIN_AVG_SCORE = 0.35;
const FALLBACK_MIN_AVG_SCORE = 0.72;
const TOP_N_FOR_CONFIDENCE = 3;

const REFUSAL_OFF_TOPIC =
    "I couldn't find anything in the attached document(s) that answers this. Could you rephrase, or ask something the document(s) actually cover?";
const REFUSAL_UNSAFE =
    "I can't help with that request. Let me know if there's something else I can do.";

export async function POST(req: NextRequest) {
    const db = await getDb();
    const { sessionId, message, documentIds } = await req.json();

    if (!message || typeof message !== "string" || !message.trim()) {
        return new Response(JSON.stringify({ error: "message is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (message.length > 4000) {
        return new Response(JSON.stringify({ error: "message too long" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const scopedDocumentIds: string[] = Array.isArray(documentIds)
        ? documentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
    const isScoped = scopedDocumentIds.length > 0;

    // Guardrail 1: input safety moderation
    // Runs before the DB/session work so a flagged message never consumes
    // retrieval or generation budget.
    let moderationFlagged = false;
    try {
        const moderation = await withRetry(
            () =>
                openai.moderations.create({
                    model: MODERATION_MODEL,
                    input: message,
                }),
            { isRetryable: isRetryableError, getRetryAfterMs }
        );
        moderationFlagged = moderation.results?.[0]?.flagged ?? false;
    } catch (err) {
        console.error("Moderation check failed", err);
    }

    let activeSessionId = sessionId as string | undefined;

    if (!activeSessionId) {
        const title = message.trim().slice(0, 60);
        const [session] = await db
            .insert(chatSessions)
            .values({ title })
            .returning({ id: chatSessions.id });
        activeSessionId = session.id;
    } else {
        await db
            .update(chatSessions)
            .set({ lastActiveAt: new Date() })
            .where(eq(chatSessions.id, activeSessionId));
    }

    const priorMessages = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, activeSessionId))
        .orderBy(asc(chatMessages.createdAt));

    await db.insert(chatMessages).values({
        sessionId: activeSessionId,
        role: "user",
        content: message,
    });

    const encoder = new TextEncoder();
    const activeSessionIdFinal = activeSessionId;

    // Shared helper for the two guardrail short-circuit paths below: sends
    // meta + a single token + done, storing the refusal as the assistant
    // turn so history/session state stay consistent with a normal reply.
    const sendGuardrailRefusal = (refusalText: string, sourceCount: number) => {
        return new ReadableStream({
            async start(controller) {
                const send = (obj: unknown) => {
                    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
                };

                send({
                    type: "meta",
                    sessionId: activeSessionIdFinal,
                    grounded: false,
                    sourceCount,
                    blocked: true,
                });
                send({
                    type: "token",
                    content: refusalText,
                    grounded: false,
                    sourceCount,
                    blocked: true,
                });

                const [assistantMessage] = await db
                    .insert(chatMessages)
                    .values({
                        sessionId: activeSessionIdFinal,
                        role: "assistant",
                        content: refusalText,
                    })
                    .returning();

                send({ type: "done", messageId: assistantMessage.id });
                controller.close();
            },
        });
    };

    if (moderationFlagged) {
        return new Response(sendGuardrailRefusal(REFUSAL_UNSAFE, 0), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
    }

    const t = timers();

    t.start("embed");

    const embeddingRes = await withRetry(
        () =>
            openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: message,
            }),
        {
            isRetryable: isRetryableError,
            getRetryAfterMs,
            onRetry: (err, attempt, delayMs) =>
                console.warn(`OpenAI embeddings retry ${attempt}`, { delayMs, err }),
        }
    );

    const embedMs = t.end("embed");

    const queryVector = embeddingRes.data[0].embedding;

    const topK = isScoped
        ? Math.min(TOP_K_SCOPED_MAX, TOP_K_SCOPED_PER_DOC * scopedDocumentIds.length)
        : TOP_K;

    t.start("retrieve");

    // Pinecone call wrapped in the same retry/backoff policy as the OpenAI
    // calls above — a transient Pinecone timeout or 5xx no longer fails the
    // whole turn outright.
    let matches = await withRetry(
        () =>
            querySimilar(
                NAMESPACE,
                queryVector,
                topK,
                isScoped ? { sourceId: { $in: scopedDocumentIds } } : undefined
            ),
        {
            isRetryable: isRetryableError,
            getRetryAfterMs,
            onRetry: (err, attempt, delayMs) =>
                console.warn(`Pinecone query retry ${attempt}`, { delayMs, err }),
        }
    );

    const retrieveMs = t.end("retrieve");

    let matchesAreScoped = isScoped;

    // Tracks whether `matches` currently holds results from the ORIGINAL
    // sourceId-filtered (scoped) query, or from the unscoped fallback below.
    // This matters for the confidence check further down: scoped matches
    // are already guaranteed to come from the attached document(s), so a
    // low similarity score there just means the question was phrased
    // abstractly (e.g. "summarize this") — not that the doc lacks the
    // answer. Fallback matches carry no such guarantee, so they still need
    // a real similarity bar.
    if (isScoped && matches.length === 0) {
        matches = await withRetry(
            () => querySimilar(NAMESPACE, queryVector, TOP_K),
            {
                isRetryable: isRetryableError,
                getRetryAfterMs,
                onRetry: (err, attempt, delayMs) =>
                    console.warn(`Pinecone fallback query retry ${attempt}`, { delayMs, err }),
            }
        );
        matchesAreScoped = false;
    }

    const retrievalPipelineMs = embedMs + retrieveMs;

    const topMatches = matches.slice(0, TOP_N_FOR_CONFIDENCE);
    const avgTopScore =
        topMatches.length > 0
            ? topMatches.reduce((sum, m) => sum + (m.score ?? 0), 0) / topMatches.length
            : 0;

    const confidenceThreshold = matchesAreScoped ? SCOPED_MIN_AVG_SCORE : FALLBACK_MIN_AVG_SCORE;
    const isLowConfidence = isScoped && (matches.length === 0 || avgTopScore < confidenceThreshold);

    // MOVED UP — log unconditionally, before either guardrail return, so we
    // can see exactly what happened on refused requests too.


    if (isLowConfidence) {
        return new Response(sendGuardrailRefusal(REFUSAL_OFF_TOPIC, matches.length), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
    }

    const context = matches.map((m, i) => `[${i + 1}] ${m.text}`).join("\n\n");

    const systemPrompt = isScoped
        ? `You are a helpful assistant. The user has attached specific document(s) and is asking about them. Answer strictly using the retrieved context below — it comes directly from the attached document(s). Do not fill gaps with general knowledge or invented details; if the context doesn't fully answer the question, say so explicitly rather than guessing.\n\nRetrieved context:\n${context}`
        : context
            ? `You are a helpful assistant. Use the retrieved context below to answer the user's question when it's relevant. If the context is only partially relevant or doesn't fully cover the question, fill the gaps using your own general knowledge — don't refuse or say you lack information just because the context is incomplete. If the context is entirely irrelevant to the question, ignore it and answer from your own knowledge instead.\n\nRetrieved context:\n${context}`
            : `You are a helpful assistant. No relevant document context was found for this question — answer it using your own general knowledge.`;

    const historyMessages = priorMessages.slice(-HISTORY_LIMIT).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
    }));

    const groundedFinal = matches.length > 0;
    const sourceCountFinal = matches.length;

    const stream = new ReadableStream({
        async start(controller) {
            const send = (obj: unknown) => {
                controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
            };

            send({
                type: "meta",
                sessionId: activeSessionIdFinal,
                grounded: groundedFinal,
                sourceCount: sourceCountFinal,
            });

            let fullContent = "";

            try {
                const completionStream = await withRetry(
                    () =>
                        openai.chat.completions.create({
                            model: CHAT_MODEL,
                            messages: [
                                { role: "system", content: systemPrompt },
                                ...historyMessages,
                                { role: "user", content: message },
                            ],
                            stream: true,
                        }),
                    {
                        isRetryable: isRetryableError,
                        getRetryAfterMs,
                        onRetry: (err, attempt, delayMs) =>
                            console.warn(`OpenAI chat completion retry ${attempt}`, { delayMs, err }),
                    }
                );

                for await (const chunk of completionStream) {
                    const delta = chunk.choices[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                        send({ type: "token", content: delta });
                    }
                }
            } catch (err) {
                console.error("Streaming error", err);
                send({ type: "error", message: "Failed to generate a response." });
                controller.close();
                return;
            }

            const [assistantMessage] = await db
                .insert(chatMessages)
                .values({
                    sessionId: activeSessionIdFinal,
                    role: "assistant",
                    content: fullContent || "Sorry, I wasn't able to generate a response.",
                })
                .returning();

            send({ type: "done", messageId: assistantMessage.id });
            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
        },
    });
}