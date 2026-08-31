import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@/src/lib/sarvam";

export async function POST(req: NextRequest) {
    try {
        const { text, targetLanguageCode = "en-IN", speaker = "anushka" } = await req.json();

        if (!text || typeof text !== "string" || !text.trim()) {
            return NextResponse.json({ error: "Text is required" }, { status: 400 });
        }

        const audioUrl = await synthesizeSpeech(text.trim(), targetLanguageCode, speaker);
        return NextResponse.json({ audioUrl });
    } catch (err: any) {
        console.error("TTS generation error:", err);
        return NextResponse.json({ error: err.message || "Failed to generate speech" }, { status: 500 });
    }
}