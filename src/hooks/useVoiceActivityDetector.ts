// FILE: src/hooks/useVoiceActivityDetector.ts
"use client";

import { useRef, useCallback, useEffect } from "react";

interface VADOptions {
    speechThreshold?: number;      // RMS level (0-1) that counts as speech
    speechFramesToTrigger?: number; // consecutive frames above threshold to confirm speech start
    silenceMsToTrigger?: number;    // ms of continuous silence to confirm speech end
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
}

export function useVoiceActivityDetector() {
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const dataRef = useRef<Uint8Array | null>(null);

    const speakingRef = useRef(false);
    const speechFrameCountRef = useRef(0);
    const silenceStartRef = useRef<number | null>(null);
    const optsRef = useRef<Required<VADOptions>>({
        speechThreshold: 0.05,
        speechFramesToTrigger: 3,
        silenceMsToTrigger: 750,
        onSpeechStart: () => { },
        onSpeechEnd: () => { },
    });

    const start = useCallback((stream: MediaStream, opts: VADOptions = {}) => {
        optsRef.current = { ...optsRef.current, ...opts };

        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);

        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        sourceRef.current = source;
        dataRef.current = new Uint8Array(analyser.fftSize);
        speakingRef.current = false;
        speechFrameCountRef.current = 0;
        silenceStartRef.current = null;

        const tick = () => {
            const analyserNode = analyserRef.current;
            const data = dataRef.current;
            if (!analyserNode || !data) return;

            analyserNode.getByteTimeDomainData(data);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) {
                const norm = (data[i] - 128) / 128;
                sumSquares += norm * norm;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            const { speechThreshold, speechFramesToTrigger, silenceMsToTrigger, onSpeechStart, onSpeechEnd } =
                optsRef.current;

            if (rms > speechThreshold) {
                speechFrameCountRef.current += 1;
                silenceStartRef.current = null;

                if (!speakingRef.current && speechFrameCountRef.current >= speechFramesToTrigger) {
                    speakingRef.current = true;
                    onSpeechStart();
                }
            } else {
                speechFrameCountRef.current = 0;

                if (speakingRef.current) {
                    if (silenceStartRef.current === null) {
                        silenceStartRef.current = performance.now();
                    } else if (performance.now() - silenceStartRef.current >= silenceMsToTrigger) {
                        speakingRef.current = false;
                        silenceStartRef.current = null;
                        onSpeechEnd();
                    }
                }
            }

            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
    }, []);

    // Lets the caller retune thresholds without tearing down the AudioContext
    // (e.g. raise the bar while the assistant's TTS is playing, to cut down
    // on speaker-bleed false triggers).
    const updateOptions = useCallback((opts: Partial<VADOptions>) => {
        optsRef.current = { ...optsRef.current, ...opts };
    }, []);

    const stop = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        sourceRef.current?.disconnect();
        analyserRef.current?.disconnect();
        audioCtxRef.current?.close().catch(() => { });
        audioCtxRef.current = null;
        analyserRef.current = null;
        sourceRef.current = null;
        speakingRef.current = false;
        speechFrameCountRef.current = 0;
        silenceStartRef.current = null;
    }, []);

    useEffect(() => () => stop(), [stop]);

    return { start, stop, updateOptions };
}