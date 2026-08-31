// FILE: src/hooks/useVoiceRecorder.ts
"use client";

import { useRef, useCallback } from "react";

const SILENCE_THRESHOLD = 8;
const SILENCE_DURATION_MS = 1200;
const MAX_RECORDING_MS = 15000;
export const VOICE_BAR_COUNT = 24;

export function useVoiceRecorder() {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const rafRef = useRef<number | null>(null);
    const cancelledRef = useRef(false);

    const cleanup = useCallback(() => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        audioContextRef.current?.close();
        streamRef.current = null;
        audioContextRef.current = null;
    }, []);

    // Resolves with the recorded Blob (or null if cancel() was called)
    // once recording stops — via silence, stop(), max duration, or cancel().
    const record = useCallback(
        (onLevels?: (bars: number[]) => void): Promise<Blob | null> => {
            cancelledRef.current = false;

            return new Promise(async (resolve, reject) => {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    streamRef.current = stream;

                    const audioContext = new AudioContext();
                    audioContextRef.current = audioContext;
                    const source = audioContext.createMediaStreamSource(stream);
                    const analyser = audioContext.createAnalyser();
                    analyser.fftSize = 128;
                    source.connect(analyser);

                    const freqData = new Uint8Array(analyser.frequencyBinCount);
                    const step = Math.floor(freqData.length / VOICE_BAR_COUNT) || 1;

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
                        resolve(
                            cancelledRef.current
                                ? null
                                : new Blob(chunksRef.current, { type: mimeType })
                        );
                    };

                    recorder.start();

                    maxTimerRef.current = setTimeout(() => {
                        if (recorder.state !== "inactive") recorder.stop();
                    }, MAX_RECORDING_MS);

                    let hasSpoken = false;

                    const tick = () => {
                        if (recorder.state === "inactive") return;
                        analyser.getByteFrequencyData(freqData);

                        const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;

                        onLevels?.(
                            Array.from({ length: VOICE_BAR_COUNT }, (_, i) => (freqData[i * step] ?? 0) / 255)
                        );

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

                        rafRef.current = requestAnimationFrame(tick);
                    };
                    rafRef.current = requestAnimationFrame(tick);
                } catch (err) {
                    cleanup();
                    reject(err);
                }
            });
        },
        [cleanup]
    );

    const stop = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
        }
    }, []);

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        stop();
    }, [stop]);

    return { record, stop, cancel };
}