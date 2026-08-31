// FILE: src/app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/src/lib/sarvam";

export async function POST(req: NextRequest) {
    const formData = await req.formData();
    const audio = formData.get("audio") as File | null;

    if (!audio) {
        return NextResponse.json({ error: "audio is required" }, { status: 400 });
    }

    try {
        const transcript = await transcribeAudio(audio, audio.name || "audio.webm");
        return NextResponse.json({ transcript });
    } catch (err) {
        console.error("STT error", err);
        return NextResponse.json({ error: "transcription failed" }, { status: 500 });
    }
}