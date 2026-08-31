// FILE: src/hooks/useVoiceRecorder.ts
"use client";

import { useRef, useCallback } from "react";

const SILENCE_THRESHOLD = 8; // 0-255 volume scale
const SILENCE_DURATION_MS = 1200; // how long silence must persist to auto-stop
const MAX_RECORDING_MS = 15000; // safety cap

export function useVoiceRecorder() {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    const cleanup = useCallback(() => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        audioContextRef.current?.close();
        streamRef.current = null;
        audioContextRef.current = null;
    }, []);

    // Resolves with the recorded audio Blob once silence is detected
    // (or the recorder is stopped manually / hits the max duration cap).
    const record = useCallback((): Promise<Blob> => {
        return new Promise(async (resolve, reject) => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                streamRef.current = stream;

                const audioContext = new AudioContext();
                audioContextRef.current = audioContext;
                const source = audioContext.createMediaStreamSource(stream);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 512;
                source.connect(analyser);

                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                const mimeType = MediaRecorder.isTypeSupported("audio/webm")
                    ? "audio/webm"
                    : "audio/mp4";
                const recorder = new MediaRecorder(stream, { mimeType });
                mediaRecorderRef.current = recorder;
                chunksRef.current = [];

                recorder.ondataavailable = (e) => {
                    if (e.data.size > 0) chunksRef.current.push(e.data);
                };

                recorder.onstop = () => {
                    cleanup();
                    resolve(new Blob(chunksRef.current, { type: mimeType }));
                };

                recorder.start();

                maxTimerRef.current = setTimeout(() => {
                    if (recorder.state !== "inactive") recorder.stop();
                }, MAX_RECORDING_MS);

                // Poll volume; reset the silence timer whenever we hear sound
                // above threshold, and stop once silence has persisted long enough.
                let hasSpoken = false;
                const checkVolume = () => {
                    if (recorder.state === "inactive") return;
                    analyser.getByteFrequencyData(dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

                    if (avg > SILENCE_THRESHOLD) {
                        hasSpoken = true;
                        if (silenceTimerRef.current) {
                            clearTimeout(silenceTimerRef.current);
                            silenceTimerRef.current = null;
                        }
                    } else if (hasSpoken && !silenceTimerRef.current) {
                        silenceTimerRef.current = setTimeout(() => {
                            if (recorder.state !== "inactive") recorder.stop();
                        }, SILENCE_DURATION_MS);
                    }

                    requestAnimationFrame(checkVolume);
                };
                requestAnimationFrame(checkVolume);
            } catch (err) {
                cleanup();
                reject(err);
            }
        });
    }, [cleanup]);

    const stop = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
        }
    }, []);

    return { record, stop };
}