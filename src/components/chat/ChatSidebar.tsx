"use client";

import { MessageSquare, Plus, Trash2 } from "lucide-react";

export type Session = {
    id: string;
    title: string | null;
    createdAt: string;
    lastActiveAt: string;
};

interface ChatSidebarProps {
    sessions: Session[];
    sessionId: string | null;
    sessionsLoading: boolean;
    onNewChat: () => void;
    onSelectSession: (id: string) => void;
    onDeleteSession: (id: string, e: React.MouseEvent) => void;
}

export function ChatSidebar({
    sessions,
    sessionId,
    sessionsLoading,
    onNewChat,
    onSelectSession,
    onDeleteSession,
}: ChatSidebarProps) {
    return (
        <aside className="hidden md:flex w-64 flex-col justify-between border-r border-neutral-800/80 bg-neutral-950 p-3 select-none">
            <div className="flex min-h-0 flex-1 flex-col space-y-4">
                <button
                    onClick={onNewChat}
                    className="flex w-full items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm font-medium text-neutral-200 transition-all hover:border-neutral-700 hover:bg-neutral-800/80 active:scale-[0.99] cursor-pointer"
                >
                    <Plus className="h-4 w-4 text-neutral-400" />
                    <span>New chat</span>
                </button>

                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
                    <span className="px-2.5 text-[11px] font-medium tracking-wider uppercase text-neutral-500">
                        Recent
                    </span>

                    {sessionsLoading && (
                        <p className="px-2.5 py-3 text-xs text-neutral-500 animate-pulse">Loading chats...</p>
                    )}

                    {!sessionsLoading && sessions.length === 0 && (
                        <p className="px-2.5 py-3 text-xs text-neutral-500">No previous sessions</p>
                    )}

                    {sessions.map((s) => {
                        const isSelected = s.id === sessionId;
                        return (
                            <button
                                key={s.id}
                                onClick={() => onSelectSession(s.id)}
                                className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${isSelected
                                        ? "bg-neutral-800/80 text-neutral-100 font-medium"
                                        : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                                    }`}
                            >
                                <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                                <span className="flex-1 truncate">{s.title || "Untitled conversation"}</span>
                                <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => onDeleteSession(s.id, e)}
                                    aria-label="Delete chat"
                                    className="shrink-0 rounded p-1 text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-700/60 hover:text-neutral-200 group-hover:opacity-100 cursor-pointer"
                                >
                                    <Trash2 className="h-3 w-3" />
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </aside>
    );
}