// src/hooks/useAudioHistory.ts
import { useState, useEffect, useRef } from "react";

export function useAudioHistory(levels: number[], barCount: number = 42, isRecording: boolean) {
    const [history, setHistory] = useState<number[]>(() => Array(barCount).fill(0));
    const latestLevelRef = useRef(0);

    // Calculate average instantaneous volume from current mic levels
    useEffect(() => {
        if (levels.length > 0) {
            const avg = levels.reduce((sum, v) => sum + v, 0) / levels.length;
            latestLevelRef.current = avg;
        }
    }, [levels]);

    // Push new audio levels from right to left every 60ms
    useEffect(() => {
        if (!isRecording) {
            setHistory(Array(barCount).fill(0));
            return;
        }

        const interval = setInterval(() => {
            setHistory((prev) => {
                const next = [...prev.slice(1), latestLevelRef.current];
                return next;
            });
        }, 60);

        return () => clearInterval(interval);
    }, [isRecording, barCount]);

    return history;
}