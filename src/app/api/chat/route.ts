// FILE: src/app/api/chat/route.ts
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { querySimilar } from "@/src/lib/pinecone";

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";
const MODERATION_MODEL = "omni-moderation-latest";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const HISTORY_LIMIT = 20;
const TOP_K = 5;
const TOP_K_SCOPED_PER_DOC = 8;
const TOP_K_SCOPED_MAX = 24;

// Guardrail: minimum Pinecone cosine similarity (0–1) for a scoped query's
// top match to be trusted. Below this, the attached document(s) probably
// don't actually cover the question — refuse rather than let the model
// paper over the gap with general knowledge. Tune against real score
// distributions from your embedding model/corpus.
const SCOPED_CONFIDENCE_THRESHOLD = 0.72;

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

    const scopedDocumentIds: string[] = Array.isArray(documentIds)
        ? documentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
    const isScoped = scopedDocumentIds.length > 0;

    // Guardrail 1: input safety moderation
    // Runs before the DB/session work so a flagged message never consumes
    // retrieval or generation budget.
    let moderationFlagged = false;
    try {
        const moderation = await openai.moderations.create({
            model: MODERATION_MODEL,
            input: message,
        });
        moderationFlagged = moderation.results?.[0]?.flagged ?? false;
    } catch (err) {
        // Moderation service failing shouldn't block the whole chat.
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

    const embeddingRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: message,
    });
    const queryVector = embeddingRes.data[0].embedding;

    const topK = isScoped
        ? Math.min(TOP_K_SCOPED_MAX, TOP_K_SCOPED_PER_DOC * scopedDocumentIds.length)
        : TOP_K;

    let matches = await querySimilar(
        NAMESPACE,
        queryVector,
        topK,
        isScoped ? { sourceId: { $in: scopedDocumentIds } } : undefined
    );

    if (isScoped && matches.length === 0) {
        matches = await querySimilar(NAMESPACE, queryVector, TOP_K);
    }

    // Guardrail 2: off-topic / low-confidence refusal
    // Only enforced when the user has attached specific documents — a
    // scoped question with a weak top match means the doc(s) likely don't
    // cover it, so refuse instead of letting the model improvise an answer.
    const topScore = matches[0]?.score ?? 0;
    const isLowConfidence = isScoped && (matches.length === 0 || topScore < SCOPED_CONFIDENCE_THRESHOLD);

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
                const completionStream = await openai.chat.completions.create({
                    model: CHAT_MODEL,
                    messages: [
                        { role: "system", content: systemPrompt },
                        ...historyMessages,
                        { role: "user", content: message },
                    ],
                    stream: true,
                });

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