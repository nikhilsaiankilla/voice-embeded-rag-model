import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "@/src/db";
import { chatSessions } from "@/src/db/schema";

export async function GET() {
    const db = await getDb();

    const sessions = await db
        .select()
        .from(chatSessions)
        .orderBy(desc(chatSessions.lastActiveAt));

    return NextResponse.json({ sessions });
}