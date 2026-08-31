"use client";

import { useRef } from "react";
import { Paperclip, Mic, ArrowUp, Loader2, Volume2, Square } from "lucide-react";
import { AttachmentList, Attachment } from "./AttachmentList";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

interface ChatInputProps {
    input: string;
    setInput: (value: string) => void;
    onSubmit: (e: React.FormEvent) => void;
    onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemoveAttachment: (id: string) => void;
    attachments: Attachment[];
    isRecording: boolean;
    isTranscribing: boolean;
    isPlayingAssistantAudio?: boolean;
    onStopAssistantAudio?: () => void;
    isBusy: boolean;
    anyUploading: boolean;
    audioHistory: number[];
    onStartRecording: () => void;
    onCancelRecording: () => void;
    onStopToInput: () => void;
    onStopAndSend: () => void;
}

export function ChatInput({
    input,
    setInput,
    onSubmit,
    onFileSelect,
    onRemoveAttachment,
    attachments,
    isRecording,
    isTranscribing,
    isPlayingAssistantAudio,
    onStopAssistantAudio,
    isBusy,
    anyUploading,
    audioHistory,
    onStartRecording,
    onCancelRecording,
    onStopToInput,
    onStopAndSend,
}: ChatInputProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    return (
        <div className="p-4 bg-gradient-to-t from-neutral-950 via-neutral-950 to-transparent mb-5">
            <div className="mx-auto max-w-3xl">
                {/* Attachment chips */}
                <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />

                {/* Transcribing Indicator */}
                {isTranscribing && (
                    <div className="mb-2 flex items-center gap-2 px-3 text-xs text-neutral-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                        <span>Transcribing audio...</span>
                    </div>
                )}

                {/* Live Audio Playback Banner */}
                {isPlayingAssistantAudio && !isRecording && (
                    <div className="mb-2 flex items-center justify-between rounded-full border border-emerald-500/20 bg-emerald-950/20 px-3.5 py-1.5 text-xs text-emerald-300 backdrop-blur">
                        <div className="flex items-center gap-2">
                            <Volume2 className="h-3.5 w-3.5 animate-pulse text-emerald-400" />
                            <span>Assistant is speaking...</span>
                        </div>
                        {onStopAssistantAudio && (
                            <button
                                type="button"
                                onClick={onStopAssistantAudio}
                                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-neutral-400 transition hover:bg-neutral-800/80 hover:text-neutral-200 cursor-pointer"
                            >
                                <Square className="h-2.5 w-2.5 fill-current" />
                                <span>Stop</span>
                            </button>
                        )}
                    </div>
                )}

                {/* Interactive Pill */}
                {isRecording ? (
                    <VoiceRecordingBar
                        audioHistory={audioHistory}
                        onCancel={onCancelRecording}
                        onStopToInput={onStopToInput}
                        onStopAndSend={onStopAndSend}
                    />
                ) : (
                    <form
                        onSubmit={onSubmit}
                        className="flex h-14 w-full items-center justify-between rounded-full border border-neutral-800/90 bg-neutral-900/95 px-3.5 shadow-2xl backdrop-blur transition-all focus-within:border-neutral-700"
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={onFileSelect}
                        />

                        {/* Left Action: Paperclip */}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isBusy}
                            aria-label="Attach document"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-400 transition hover:bg-neutral-700 hover:text-neutral-100 active:scale-95 disabled:opacity-30 disabled:hover:bg-neutral-800/80 cursor-pointer disabled:cursor-not-allowed"
                        >
                            <Paperclip className="h-4 w-4" />
                        </button>

                        {/* Center: Text input */}
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder={isBusy ? "Generating response..." : "Ask Voice Assistant..."}
                            disabled={isBusy}
                            className="flex-1 bg-transparent px-4 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none disabled:opacity-50"
                        />

                        {/* Right Actions: Mic & Submit Button */}
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={onStartRecording}
                                disabled={isBusy}
                                aria-label="Start voice recording"
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800/90 border border-neutral-700/50 text-neutral-300 transition hover:bg-neutral-700 hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:bg-neutral-800/90 cursor-pointer disabled:cursor-not-allowed"
                            >
                                <Mic className="h-4 w-4" />
                            </button>

                            <button
                                type="submit"
                                disabled={(!input.trim() && attachments.length === 0) || isBusy || anyUploading}
                                aria-label="Send message"
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition hover:bg-blue-500 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-blue-600 cursor-pointer"
                            >
                                <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}