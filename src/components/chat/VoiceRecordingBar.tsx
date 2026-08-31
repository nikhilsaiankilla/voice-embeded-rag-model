"use client";

import { X, Square, ArrowUp } from "lucide-react";

interface VoiceRecordingBarProps {
    audioHistory: number[];
    onCancel: () => void;
    onStopToInput: () => void;
    onStopAndSend: () => void;
}

export function VoiceRecordingBar({
    audioHistory,
    onCancel,
    onStopToInput,
    onStopAndSend,
}: VoiceRecordingBarProps) {
    return (
        <div className="flex h-14 w-full items-center justify-between rounded-full border border-neutral-800/90 bg-neutral-900/95 px-3.5 shadow-2xl backdrop-blur">
            {/* Cancel Button */}
            <button
                type="button"
                onClick={onCancel}
                aria-label="Cancel recording"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-400 transition hover:bg-neutral-700 hover:text-neutral-100 active:scale-95"
            >
                <X className="h-4 w-4" />
            </button>

            {/* Dynamic Audio Timeline Visualizer */}
            <div className="flex flex-1 h-9 items-center justify-between overflow-hidden px-4">
                {audioHistory.map((val, i) => {
                    const isSilent = val < 0.08;
                    const heightPx = isSilent
                        ? 3
                        : Math.max(4, Math.min(28, Math.round(val * 34)));

                    const opacity = isSilent
                        ? 0.3
                        : Math.max(0.6, Math.min(1, 0.5 + val * 0.9));

                    return (
                        <span
                            key={i}
                            className={`shrink-0 rounded-full transition-all duration-75 ease-out ${isSilent ? "w-[3px] bg-neutral-600" : "w-[2.5px] bg-neutral-200"
                                }`}
                            style={{
                                height: `${heightPx}px`,
                                opacity: opacity,
                            }}
                        />
                    );
                })}
            </div>

            {/* Actions */}
            <div className="flex shrink-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onStopToInput}
                    aria-label="Stop and insert text"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800/90 border border-neutral-700/50 text-neutral-300 transition hover:bg-neutral-700 hover:text-white active:scale-95"
                >
                    <Square className="h-3 w-3 fill-current" />
                </button>

                <button
                    type="button"
                    onClick={onStopAndSend}
                    aria-label="Stop and send"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition hover:bg-blue-500 active:scale-95"
                >
                    <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                </button>
            </div>
        </div>
    );
}