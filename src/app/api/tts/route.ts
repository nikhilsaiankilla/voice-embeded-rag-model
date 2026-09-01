// FILE: src/app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech, SARVAM_BULBUL_V3_SPEAKERS } from "@/src/lib/sarvam";

export async function POST(req: NextRequest) {
    try {
        const { text, targetLanguageCode = "en-IN", speaker = "priya" } = await req.json();

        if (!text || typeof text !== "string" || !text.trim()) {
            return NextResponse.json({ error: "Text is required" }, { status: 400 });
        }

        // Fail fast with a clear message instead of a raw Sarvam 400 if a
        // caller ever passes a speaker that isn't valid for bulbul:v3.
        if (!SARVAM_BULBUL_V3_SPEAKERS.includes(speaker)) {
            return NextResponse.json(
                {
                    error: `Speaker "${speaker}" is not valid for bulbul:v3. Valid speakers: ${SARVAM_BULBUL_V3_SPEAKERS.join(", ")}`,
                },
                { status: 400 }
            );
        }

        const audioUrl = await synthesizeSpeech(text.trim(), targetLanguageCode, speaker);
        return NextResponse.json({ audioUrl });
    } catch (err: any) {
        console.error("TTS generation error:", err);
        return NextResponse.json({ error: err.message || "Failed to generate speech" }, { status: 500 });
    }
}