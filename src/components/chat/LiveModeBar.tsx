// FILE: src/components/chat/LiveModeBar.tsx
"use client";

import { Ear, Mic, Loader2, X } from "lucide-react";
import type { LivePhase } from "@/src/hooks/useLiveConversation";

interface LiveModeBarProps {
    phase: LivePhase;
    onEnd: () => void;
}

const PHASE_COPY: Record<LivePhase, { label: string; icon: React.ReactNode }> = {
    off: { label: "", icon: null },
    listening: { label: "Listening…", icon: <Ear className="h-4 w-4 text-emerald-400" /> },
    recording: { label: "Hearing you…", icon: <Mic className="h-4 w-4 text-emerald-400 animate-pulse" /> },
    processing: {
        label: "Thinking / speaking…",
        icon: <Loader2 className="h-4 w-4 text-emerald-400 animate-spin" />,
    },
};

export function LiveModeBar({ phase, onEnd }: LiveModeBarProps) {
    const copy = PHASE_COPY[phase];

    return (
        <div className="flex h-14 w-full items-center justify-between rounded-full border border-emerald-500/30 bg-emerald-950/20 px-5 shadow-2xl backdrop-blur">
            <div className="flex items-center gap-2.5 text-sm text-emerald-200">
                {copy.icon}
                <span>{copy.label}</span>
            </div>
            <button
                type="button"
                onClick={onEnd}
                aria-label="End live conversation"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800/90 border border-neutral-700/50 text-neutral-300 transition hover:bg-red-900/60 hover:text-red-200 active:scale-95 cursor-pointer"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}