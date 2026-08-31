import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/src/lib/sarvam";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("audio") as Blob | null;

        if (!file || file.size === 0) {
            return NextResponse.json({ transcript: "" }, { status: 200 });
        }

        const transcript = await transcribeAudio(file);
        return NextResponse.json({ transcript: transcript ?? "" });
    } catch (err: any) {
        console.error("STT Route Error:", err);
        return NextResponse.json(
            { error: err.message || "Failed to transcribe audio" },
            { status: 500 }
        );
    }
}