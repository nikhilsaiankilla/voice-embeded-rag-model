"use client";

import { useRef, useCallback, useState } from "react";

interface ProgressiveAudioPlayerOptions {
    onAllPlaybackEnded?: () => void;
}

export function useProgressiveAudioPlayer(options?: ProgressiveAudioPlayerOptions) {
    const [isPlaying, setIsPlaying] = useState(false);
    const audioQueueRef = useRef<string[]>([]);
    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const isPlayingRef = useRef(false);
    const isExpectingMoreRef = useRef(false);
    const onAllPlaybackEndedRef = useRef(options?.onAllPlaybackEnded);
    onAllPlaybackEndedRef.current = options?.onAllPlaybackEnded;

    const playNext = useCallback(() => {
        if (audioQueueRef.current.length === 0) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            if (!isExpectingMoreRef.current) {
                onAllPlaybackEndedRef.current?.();
            }
            return;
        }

        isPlayingRef.current = true;
        setIsPlaying(true);

        const nextAudioSrc = audioQueueRef.current.shift()!;
        const audio = new Audio(nextAudioSrc);
        currentAudioRef.current = audio;

        audio.onended = () => {
            currentAudioRef.current = null;
            playNext();
        };

        audio.onerror = (e) => {
            console.error("Audio playback error:", e);
            currentAudioRef.current = null;
            playNext();
        };

        audio.play().catch((err) => {
            console.warn("Audio play prevented:", err);
            playNext();
        });
    }, []);

    const queueSentenceForTTS = useCallback(
        async (sentence: string) => {
            if (!sentence.trim()) return;
            isExpectingMoreRef.current = true;

            try {
                const res = await fetch("/api/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: sentence }),
                });

                if (!res.ok) return;
                const data = await res.json();
                if (data.audioUrl) {
                    audioQueueRef.current.push(data.audioUrl);
                    if (!isPlayingRef.current) {
                        playNext();
                    }
                }
            } catch (err) {
                console.error("Failed to queue sentence for TTS:", err);
            }
        },
        [playNext]
    );

    const markStreamDone = useCallback(() => {
        isExpectingMoreRef.current = false;
        if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
            onAllPlaybackEndedRef.current?.();
        }
    }, []);

    const stopAll = useCallback(() => {
        isExpectingMoreRef.current = false;
        audioQueueRef.current = [];
        if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current = null;
        }
        isPlayingRef.current = false;
        setIsPlaying(false);
    }, []);

    return {
        isPlaying,
        queueSentenceForTTS,
        markStreamDone,
        stopAll,
    };
}