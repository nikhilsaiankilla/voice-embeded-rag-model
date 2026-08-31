import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const db = await getDb();
    const paramsId = (await params).id;

    await db.delete(chatMessages).where(eq(chatMessages.sessionId, paramsId));
    await db.delete(chatSessions).where(eq(chatSessions.id, paramsId));

    return NextResponse.json({ success: true });
}