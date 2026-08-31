"use client";

import { FileText, Loader2, CheckCircle2, AlertCircle, X } from "lucide-react";

export type UploadStatus = "uploading" | "done" | "error";

export type Attachment = {
    id: string;
    file: File;
    status: UploadStatus;
    documentId?: string;
    chunkCount?: number;
};

interface AttachmentListProps {
    attachments: Attachment[];
    onRemove: (id: string) => void;
}

export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
    if (attachments.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1.5 pb-2 px-1">
            {attachments.map((a) => {
                const isError = a.status === "error";
                const isUploading = a.status === "uploading";
                const isDone = a.status === "done";

                return (
                    <div
                        key={a.id}
                        className={`group relative flex items-center gap-2 rounded-full border pl-2.5 pr-1.5 py-1 text-xs backdrop-blur-md transition-all duration-150 ${isError
                                ? "border-red-500/20 bg-red-950/20 text-red-300"
                                : "border-neutral-800/80 bg-neutral-900/70 text-neutral-300 hover:border-neutral-700/80"
                            }`}
                    >
                        {/* Status / Document Icon */}
                        <div className="flex shrink-0 items-center justify-center">
                            {isUploading && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                            )}
                            {isDone && (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                            )}
                            {isError && (
                                <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                            )}
                        </div>

                        {/* File Info */}
                        <div className="flex items-center gap-1.5 truncate">
                            <span className="max-w-[130px] truncate font-medium text-neutral-200">
                                {a.file.name}
                            </span>

                            {isDone && a.chunkCount != null && (
                                <span className="text-[10px] font-normal text-neutral-500">
                                    {a.chunkCount} {a.chunkCount === 1 ? "chunk" : "chunks"}
                                </span>
                            )}

                            {isError && (
                                <span className="text-[10px] font-medium text-red-400">
                                    Failed
                                </span>
                            )}
                        </div>

                        {/* Remove Button */}
                        <button
                            type="button"
                            onClick={() => onRemove(a.id)}
                            aria-label={`Remove ${a.file.name}`}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 active:scale-95"
                        >
                            <X className="h-3 w-3 stroke-[2.2]" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}