// FILE: src/hooks/useMessageAudioPlayer.ts
"use client";

import { useRef, useState, useCallback } from "react";

/**
 * Standalone "click to hear this message" player — separate from the
 * progressive streaming/live-mode player. Only one message plays at a time;
 * starting a new one stops whatever was playing before.
 */
export function useMessageAudioPlayer() {
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const requestIdRef = useRef(0);

    const stop = useCallback(() => {
        requestIdRef.current += 1; // invalidate any in-flight fetch
        audioRef.current?.pause();
        audioRef.current = null;
        setPlayingId(null);
        setLoadingId(null);
    }, []);

    const speak = useCallback(
        async (id: string, text: string) => {
            const clean = text.replace(/[*#_`]/g, "").trim();
            if (!clean) return;

            // Toggle off if this exact message is already playing/loading.
            if (playingId === id || loadingId === id) {
                stop();
                return;
            }

            stop(); // stop anything else that was playing
            const myRequestId = ++requestIdRef.current;
            setLoadingId(id);

            try {
                const res = await fetch("/api/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: clean }),
                });
                const data = await res.json();

                if (myRequestId !== requestIdRef.current) return; // superseded
                if (!res.ok || !data.audioUrl) {
                    setLoadingId(null);
                    return;
                }

                const audio = new Audio(data.audioUrl);
                audioRef.current = audio;
                setLoadingId(null);
                setPlayingId(id);

                audio.onended = () => {
                    if (myRequestId === requestIdRef.current) {
                        audioRef.current = null;
                        setPlayingId(null);
                    }
                };
                audio.onerror = () => {
                    if (myRequestId === requestIdRef.current) {
                        audioRef.current = null;
                        setPlayingId(null);
                    }
                };

                await audio.play().catch(() => {
                    if (myRequestId === requestIdRef.current) {
                        audioRef.current = null;
                        setPlayingId(null);
                    }
                });
            } catch (err) {
                console.error("Failed to play message audio:", err);
                if (myRequestId === requestIdRef.current) setLoadingId(null);
            }
        },
        [playingId, loadingId, stop]
    );

    return { playingId, loadingId, speak, stop };
}