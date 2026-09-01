// FILE: src/lib/sarvam.ts
import { withRetry, isRetryableError, getRetryAfterMs, getErrorStatus } from './retry';

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

// Valid speakers for the bulbul:v3 model (per Sarvam's API error response).
// Keep this in sync if Sarvam adds/removes voices.
export const SARVAM_BULBUL_V3_SPEAKERS = [
    "aditya", "ritu", "ashutosh", "priya", "neha", "rahul", "pooja", "rohan",
    "simran", "kavya", "amit", "dev", "ishita", "shreya", "ratan", "varun",
    "manan", "sumit", "roopa", "kabir", "aayan", "shubh", "advait", "anand",
    "tanya", "tarun", "sunny", "mani", "gokul", "vijay", "shruti", "suhani",
    "mohit", "kavitha", "rehan", "soham", "rupali", "niharika",
] as const;

// fetch() only throws on network-level failure — a 429/500 comes back as a
// normal Response with ok:false. Wrap it in an Error carrying .status and
// .headers so isRetryableError/getRetryAfterMs (which key off those) work
// the same way here as they do for the OpenAI SDK's thrown errors.
class SarvamApiError extends Error {
    status: number;
    headers: Headers;
    constructor(message: string, status: number, headers: Headers) {
        super(message);
        this.name = "SarvamApiError";
        this.status = status;
        this.headers = headers;
    }
}

export async function transcribeAudio(audioBlob: Blob, filename = "audio.webm") {
    return withRetry(
        async () => {
            // Rebuilt on every attempt — cheap, and avoids any doubt about
            // whether a FormData/Blob can be safely reused across retries.
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
                throw new SarvamApiError(
                    `Sarvam STT failed: ${res.status} ${errText}`,
                    res.status,
                    res.headers
                );
            }

            const data = await res.json();
            return data.transcript as string;
        },
        {
            isRetryable: isRetryableError,
            getRetryAfterMs,
            onRetry: (err, attempt, delayMs) =>
                console.warn(`Sarvam STT retry ${attempt}`, { delayMs, status: getErrorStatus(err) }),
        }
    );
}

export async function synthesizeSpeech(
    text: string,
    targetLanguageCode = "en-IN",
    speaker = "priya"
): Promise<string> {
    return withRetry(
        async () => {
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
                throw new SarvamApiError(
                    `Sarvam TTS failed: ${res.status} ${errText}`,
                    res.status,
                    res.headers
                );
            }

            const data = await res.json();
            const base64Audio = data.audios?.[0];

            if (!base64Audio) {
                // Not transient — the same input won't produce audio on
                // retry, so don't burn attempts on it. (No .status on this
                // Error means isRetryableError correctly returns false.)
                throw new Error("No audio returned by Sarvam TTS");
            }

            return `data:audio/wav;base64,${base64Audio}`;
        },
        {
            isRetryable: isRetryableError,
            getRetryAfterMs,
            onRetry: (err, attempt, delayMs) =>
                console.warn(`Sarvam TTS retry ${attempt}`, { delayMs, status: getErrorStatus(err) }),
        }
    );
}