// FILE: src/hooks/useLiveConversation.ts
"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useVoiceActivityDetector } from "./useVoiceActivityDetector";

export type LivePhase = "off" | "listening" | "recording" | "processing";

interface UseLiveConversationOptions {
    // Fires once a full user utterance (silence after speech) has been captured.
    onUtterance: (blob: Blob, turnId: number) => void;
    // Fires the instant speech is detected while the assistant's turn is still
    // active (processing or speaking) — stop TTS / abort the request here.
    onBargeIn: () => void;
}

export function useLiveConversation({ onUtterance, onBargeIn }: UseLiveConversationOptions) {
    const [phase, setPhase] = useState<LivePhase>("off");
    const phaseRef = useRef<LivePhase>("off");
    const setPhaseSafe = (p: LivePhase) => {
        phaseRef.current = p;
        setPhase(p);
    };

    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const turnIdRef = useRef(0);
    const pendingTurnIdRef = useRef(0);
    const vad = useVoiceActivityDetector();

    const beginRecording = useCallback(() => {
        const stream = streamRef.current;
        if (!stream) return;

        // Anything other than a fresh "listening" phase means the assistant's
        // turn was still active — this is a barge-in.
        if (phaseRef.current === "processing") {
            onBargeIn();
        }

        turnIdRef.current += 1;
        pendingTurnIdRef.current = turnIdRef.current;

        chunksRef.current = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: "audio/webm" });
            chunksRef.current = [];
            const myTurnId = pendingTurnIdRef.current;
            setPhaseSafe("processing");
            if (blob.size > 800) {
                onUtterance(blob, myTurnId);
            } else {
                // Too short — treat as noise/false trigger, go straight back to listening.
                setPhaseSafe("listening");
            }
        };
        recorder.start();
        recorderRef.current = recorder;
        setPhaseSafe("recording");
    }, [onBargeIn, onUtterance]);

    const finishRecording = useCallback(() => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") return;
        recorder.stop();
        recorderRef.current = null;
    }, []);

    const start = useCallback(async () => {
        if (streamRef.current) return;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;
        setPhaseSafe("listening");

        vad.start(stream, {
            speechThreshold: 0.05,
            speechFramesToTrigger: 3,
            silenceMsToTrigger: 750,
            onSpeechStart: () => {
                // Trigger on a fresh turn (listening) or to barge in on an active one.
                if (phaseRef.current === "listening" || phaseRef.current === "processing") {
                    beginRecording();
                }
            },
            onSpeechEnd: () => {
                if (phaseRef.current === "recording") {
                    finishRecording();
                }
            },
        });
    }, [vad, beginRecording, finishRecording]);

    const stop = useCallback(() => {
        turnIdRef.current += 1; // invalidate any in-flight utterance
        vad.stop();
        recorderRef.current?.stop();
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setPhaseSafe("off");
    }, [vad]);

    // Parent calls this once a turn (STT -> chat -> TTS) is fully wrapped up.
    // Guarded so a stale/late call can't clobber a newer barge-in recording.
    const resumeListening = useCallback(() => {
        if (phaseRef.current === "processing") setPhaseSafe("listening");
    }, []);

    const isTurnCurrent = useCallback((turnId: number) => turnIdRef.current === turnId, []);

    useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

    return { phase, start, stop, resumeListening, isTurnCurrent };
}