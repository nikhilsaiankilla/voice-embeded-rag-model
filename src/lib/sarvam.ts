// FILE: src/lib/sarvam.ts
const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

export async function transcribeAudio(audioBlob: Blob, filename = "audio.webm") {
    const formData = new FormData();
    formData.append("file", audioBlob, filename);
    formData.append("model", "saaras:v3");
    formData.append("mode", "transcribe");

    const res = await fetch(SARVAM_STT_URL, {
        method: "POST",
        headers: {
            "api-subscription-key": process.env.SARVAM_API_KEY!,
        },
        body: formData,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Sarvam STT failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    return data.transcript as string;
}