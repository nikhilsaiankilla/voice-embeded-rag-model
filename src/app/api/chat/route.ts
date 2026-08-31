import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";

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
        // bump lastActiveAt on an existing session
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

    // TODO: replace with real RAG pipeline call (retrieval + LLM generation)
    const assistantContent = `You said: "${message}"`;

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