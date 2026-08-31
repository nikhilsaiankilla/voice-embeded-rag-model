import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";
import { openai } from "@/src/lib/openai";
import { querySimilar } from "@/src/lib/pinecone";

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "default";

export async function POST(req: NextRequest) {
    const db = await getDb();
    const { sessionId, message } = await req.json();

    if (!message || typeof message !== "string" || !message.trim()) {
        return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    // Create session lazily if this is the first message of a new chat
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

    // Save user message
    await db.insert(chatMessages).values({
        sessionId: activeSessionId,
        role: "user",
        content: message,
    });

    // Embed the query, then retrieve grounding context from Pinecone
    const embeddingRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: message,
    });
    const queryVector = embeddingRes.data[0].embedding;

    const matches = await querySimilar(NAMESPACE, queryVector, 5);

    const context = matches
        .map((m, i) => `[${i + 1}] ${m.text}`)
        .join("\n\n");

    const systemPrompt = context
        ? `You are a helpful assistant that answers strictly using the provided context. If the context does not contain the answer, say you don't have enough information — do not make anything up.\n\nContext:\n${context}`
        : `You are a helpful assistant. No relevant context was found for this question — let the user know you don't have grounded information to answer it.`;

    const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
        ],
    });

    const assistantContent =
        completion.choices[0]?.message?.content ??
        "Sorry, I wasn't able to generate a response.";

    const [assistantMessage] = await db
        .insert(chatMessages)
        .values({
            sessionId: activeSessionId,
            role: "assistant",
            content: assistantContent,
        })
        .returning();

    return NextResponse.json({
        sessionId: activeSessionId,
        message: assistantMessage,
    });
}