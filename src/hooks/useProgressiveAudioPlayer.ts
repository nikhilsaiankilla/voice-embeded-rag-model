// FILE: src/hooks/useProgressiveAudioPlayer.ts
"use client";

import { useRef, useCallback, useState } from "react";

interface ProgressiveAudioPlayerOptions {
    onAllPlaybackEnded?: () => void;
}

// Each queued sentence gets a slot immediately (in order), and its TTS fetch
// is kicked off right away so requests run concurrently. Playback strictly
// follows slot order — we never play slot N+1 before slot N, even if N+1's
// network request happens to resolve first. This is what makes speech sound
// sequential/continuous instead of jumping around or stalling.
interface AudioSlot {
    index: number;
    audioUrlPromise: Promise<string | null>;
}

export function useProgressiveAudioPlayer(options?: ProgressiveAudioPlayerOptions) {
    const [isPlaying, setIsPlaying] = useState(false);

    const slotsRef = useRef<AudioSlot[]>([]);
    const nextIndexToQueueRef = useRef(0); // index assigned to the next queued sentence
    const nextIndexToPlayRef = useRef(0); // index we're waiting to play next

    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const isPlayingRef = useRef(false);
    const isExpectingMoreRef = useRef(false);
    const generationRef = useRef(0); // bumped on stopAll to invalidate stale playback loops

    const onAllPlaybackEndedRef = useRef(options?.onAllPlaybackEnded);
    onAllPlaybackEndedRef.current = options?.onAllPlaybackEnded;

    const tryFinish = useCallback(() => {
        isPlayingRef.current = false;
        setIsPlaying(false);
        if (!isExpectingMoreRef.current && slotsRef.current.length === 0) {
            onAllPlaybackEndedRef.current?.();
        }
    }, []);

    const playNext = useCallback(async () => {
        const myGeneration = generationRef.current;

        // Find (and remove) the slot matching the index we're waiting on.
        // Slots can arrive in any order in slotsRef since queueSentenceForTTS
        // pushes as soon as a fetch is kicked off, so we search rather than
        // assume slotsRef[0] is next.
        const slotIdx = slotsRef.current.findIndex((s) => s.index === nextIndexToPlayRef.current);

        if (slotIdx === -1) {
            // The next sentence in order hasn't been queued yet (or we're
            // genuinely done). If more is coming, just wait — queueSentenceForTTS
            // will call playNext again once it adds the slot we need.
            tryFinish();
            return;
        }

        const [slot] = slotsRef.current.splice(slotIdx, 1);
        isPlayingRef.current = true;
        setIsPlaying(true);

        const audioUrl = await slot.audioUrlPromise;
        if (myGeneration !== generationRef.current) return; // stopAll happened mid-await

        nextIndexToPlayRef.current += 1;

        if (!audioUrl) {
            // This sentence's TTS failed — skip it and move on rather than
            // stalling the whole response.
            playNext();
            return;
        }

        const audio = new Audio(audioUrl);
        currentAudioRef.current = audio;

        audio.onended = () => {
            if (myGeneration !== generationRef.current) return;
            currentAudioRef.current = null;
            playNext();
        };

        audio.onerror = (e) => {
            console.error("Audio playback error:", e);
            if (myGeneration !== generationRef.current) return;
            currentAudioRef.current = null;
            playNext();
        };

        audio.play().catch((err) => {
            console.warn("Audio play prevented:", err);
            if (myGeneration === generationRef.current) playNext();
        });
    }, [tryFinish]);

    const queueSentenceForTTS = useCallback(
        (sentence: string) => {
            const clean = sentence.trim();
            if (!clean) return;

            isExpectingMoreRef.current = true;
            const myIndex = nextIndexToQueueRef.current++;
            const myGeneration = generationRef.current;

            // Kick off the fetch immediately (don't wait for previous sentences'
            // requests) — this is what keeps latency low. Ordering is enforced
            // at playback time, not at request time.
            const audioUrlPromise: Promise<string | null> = fetch("/api/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: clean }),
            })
                .then(async (res) => {
                    if (!res.ok) return null;
                    const data = await res.json();
                    return data.audioUrl ?? null;
                })
                .catch((err) => {
                    console.error("Failed to fetch TTS for sentence:", err);
                    return null;
                });

            slotsRef.current.push({ index: myIndex, audioUrlPromise });

            if (myGeneration !== generationRef.current) return; // stopAll raced us

            if (!isPlayingRef.current) {
                playNext();
            }
        },
        [playNext]
    );

    const markStreamDone = useCallback(() => {
        isExpectingMoreRef.current = false;
        if (!isPlayingRef.current && slotsRef.current.length === 0) {
            onAllPlaybackEndedRef.current?.();
        }
    }, []);

    const stopAll = useCallback(() => {
        generationRef.current += 1; // invalidate any in-flight awaits/callbacks
        isExpectingMoreRef.current = false;
        slotsRef.current = [];
        nextIndexToQueueRef.current = 0;
        nextIndexToPlayRef.current = 0;

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