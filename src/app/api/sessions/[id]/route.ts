import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions, chatMessages } from "@/src/db/schema";

export async function DELETE(
    _req: NextRequest,
    { params }: { params: { id: string } }
) {
    const db = await getDb();
    await db.delete(chatMessages).where(eq(chatMessages.sessionId, params.id));
    await db.delete(chatSessions).where(eq(chatSessions.id, params.id));

    return NextResponse.json({ success: true });
}