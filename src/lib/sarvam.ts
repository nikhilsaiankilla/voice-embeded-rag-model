// FILE: src/lib/sarvam.ts
const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

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

export async function synthesizeSpeech(
    text: string,
    targetLanguageCode = "en-IN",
    speaker = "priya"
): Promise<string> {
    const res = await fetch(SARVAM_TTS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "api-subscription-key": process.env.SARVAM_API_KEY!,
        },
        body: JSON.stringify({
            inputs: [text],
            target_language_code: targetLanguageCode,
            speaker: speaker,
            pace: 1.0,
            speech_sample_rate: 16000,
            enable_preprocessing: true,
            model: "bulbul:v3",
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Sarvam TTS failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    const base64Audio = data.audios?.[0];

    if (!base64Audio) {
        throw new Error("No audio returned by Sarvam TTS");
    }

    return `data:audio/wav;base64,${base64Audio}`;
}