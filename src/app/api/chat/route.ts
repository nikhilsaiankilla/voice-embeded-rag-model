// FILE: src/app/api/chat/route.ts
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { querySimilar } from "@/src/lib/pinecone";

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";
const HISTORY_LIMIT = 20;
const TOP_K = 5;
// When the user has attached specific documents, pull more chunks per doc
// so we're not starved for context on longer files like resumes.
const TOP_K_SCOPED_PER_DOC = 8;
const TOP_K_SCOPED_MAX = 24;

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

    const embeddingRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: message,
    });
    const queryVector = embeddingRes.data[0].embedding;

    // When the user attached specific documents, restrict retrieval to those
    // documents' chunks via a Pinecone metadata filter, and pull more chunks
    // since we're no longer sampling across the whole namespace.
    const topK = isScoped
        ? Math.min(TOP_K_SCOPED_MAX, TOP_K_SCOPED_PER_DOC * scopedDocumentIds.length)
        : TOP_K;

    let matches = await querySimilar(
        NAMESPACE,
        queryVector,
        topK,
        isScoped ? { sourceId: { $in: scopedDocumentIds } } : undefined
    );

    // Safety net: if a scoped query somehow returns nothing (e.g. the doc
    // finished uploading but indexing hadn't propagated yet), fall back to
    // an unfiltered search rather than silently answering ungrounded.
    if (isScoped && matches.length === 0) {
        matches = await querySimilar(NAMESPACE, queryVector, TOP_K);
    }

    const context = matches.map((m, i) => `[${i + 1}] ${m.text}`).join("\n\n");

    const systemPrompt = isScoped
        ? context
            ? `You are a helpful assistant. The user has attached specific document(s) and is asking about them. Answer strictly using the retrieved context below — it comes directly from the attached document(s). Do not fill gaps with general knowledge or invented details; if the context doesn't contain the answer, say so explicitly rather than guessing.\n\nRetrieved context:\n${context}`
            : `You are a helpful assistant. The user attached document(s) for this question, but no matching content could be retrieved from them (the upload may still be indexing, or may not contain relevant information). Tell the user this plainly instead of guessing or fabricating details about the document.`
        : context
            ? `You are a helpful assistant. Use the retrieved context below to answer the user's question when it's relevant. If the context is only partially relevant or doesn't fully cover the question, fill the gaps using your own general knowledge — don't refuse or say you lack information just because the context is incomplete. If the context is entirely irrelevant to the question, ignore it and answer from your own knowledge instead.\n\nRetrieved context:\n${context}`
            : `You are a helpful assistant. No relevant document context was found for this question — answer it using your own general knowledge.`;

    const historyMessages = priorMessages.slice(-HISTORY_LIMIT).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
    }));

    const encoder = new TextEncoder();
    const activeSessionIdFinal = activeSessionId;
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