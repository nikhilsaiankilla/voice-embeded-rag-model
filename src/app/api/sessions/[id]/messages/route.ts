import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatMessages } from "@/src/db/schema";

export async function GET(
    _req: NextRequest,
    { params }: { params: { id: string } }
) {
    const db = await getDb();

    const messages = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, params.id))
        .orderBy(asc(chatMessages.createdAt));

    return NextResponse.json({ messages });
}