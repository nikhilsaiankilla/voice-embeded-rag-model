"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User, BookOpen, Globe } from "lucide-react";

export type Message = {
    id: string;
    role: "user" | "assistant";
    content: string;
    grounded?: boolean;
    sourceCount?: number;
};

interface ChatMessageItemProps {
    message: Message;
}

export function ChatMessageItem({ message }: ChatMessageItemProps) {
    const isAssistant = message.role === "assistant";

    return (
        <div className={`flex gap-3.5 ${isAssistant ? "items-start" : "items-start flex-row-reverse"}`}>
            {/* Avatar Icon */}
            <div
                className={`flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-lg text-xs transition-colors ${isAssistant
                        ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                        : "bg-neutral-800 border border-neutral-700/60 text-neutral-300"
                    }`}
            >
                {isAssistant ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
            </div>

            {/* Bubble Container */}
            <div className={`flex max-w-[85%] flex-col gap-1.5 ${isAssistant ? "items-start" : "items-end"}`}>
                <div
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${isAssistant
                            ? "bg-neutral-900/60 border border-neutral-800/80 text-neutral-200 rounded-tl-sm shadow-sm"
                            : "bg-neutral-800 border border-neutral-700/40 text-neutral-100 rounded-tr-sm"
                        }`}
                >
                    {isAssistant ? (
                        <div className="space-y-2 text-neutral-200 text-sm">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
                                    ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
                                    ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5">{children}</ol>,
                                    li: ({ children }) => <li className="leading-snug">{children}</li>,
                                    strong: ({ children }) => <strong className="font-semibold text-neutral-100">{children}</strong>,
                                    h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-bold text-neutral-100">{children}</h1>,
                                    h2: ({ children }) => <h2 className="mt-2.5 mb-1 text-sm font-semibold text-neutral-100">{children}</h2>,
                                    h3: ({ children }) => <h3 className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-neutral-300">{children}</h3>,
                                    code: ({ children }) => (
                                        <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
                                            {children}
                                        </code>
                                    ),
                                }}
                            >
                                {message.content}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                    )}
                </div>

                {/* Grounding Info */}
                {isAssistant && typeof message.grounded === "boolean" && (
                    <span className="flex items-center gap-1.5 px-1 text-[11px] text-neutral-500 font-medium">
                        {message.grounded ? (
                            <>
                                <BookOpen className="h-3 w-3 text-emerald-500/80" />
                                <span>
                                    Grounded · {message.sourceCount} source{message.sourceCount === 1 ? "" : "s"}
                                </span>
                            </>
                        ) : (
                            <>
                                <Globe className="h-3 w-3 text-neutral-500" />
                                <span>General knowledge</span>
                            </>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
}

export function ChatLoadingDots() {
    return (
        <div className="flex gap-3.5 items-center">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <Bot className="h-4 w-4" />
            </div>
            <div className="flex space-x-1.5 py-2 px-1">
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-600 [animation-delay:-0.3s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-600 [animation-delay:-0.15s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-600" />
            </div>
        </div>
    );
}