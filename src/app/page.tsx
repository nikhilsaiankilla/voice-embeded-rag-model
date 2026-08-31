"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Bot,
  User,
  Plus,
  MessageSquare,
  Sparkles,
  Paperclip,
  X,
  Mic,
  Square,
  FileText,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Session = {
  id: string;
  title: string | null;
  createdAt: string;
  lastActiveAt: string;
};

type UploadStatus = "uploading" | "done" | "error";

type Attachment = {
  id: string;
  file: File;
  status: UploadStatus;
  documentId?: string;
  chunkCount?: number;
};

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (err) {
      console.error("Failed to load sessions", err);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadSessionMessages = async (id: string) => {
    setSessionId(id);
    setAttachments([]);
    setInput("");
    try {
      const res = await fetch(`/api/sessions/${id}/messages`);
      const data = await res.json();
      setMessages(
        (data.messages ?? []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        }))
      );
    } catch (err) {
      console.error("Failed to load messages", err);
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setAttachments([]);
    setInput("");
    setSessionId(null);
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (sessionId === id) handleNewChat();
    } catch (err) {
      console.error("Failed to delete session", err);
    }
  };

  // Uploads a single file to /api/documents and updates its status in place.
  const uploadFile = async (attachmentId: string, file: File) => {
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();

      setAttachments((prev) =>
        prev.map((a) =>
          a.id === attachmentId
            ? {
              ...a,
              status: "done",
              documentId: data.document?.id,
              chunkCount: data.chunkCount,
            }
            : a
        )
      );
    } catch (err) {
      console.error("Failed to upload file", err);
      setAttachments((prev) =>
        prev.map((a) => (a.id === attachmentId ? { ...a, status: "error" } : a))
      );
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const newAttachments: Attachment[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "uploading",
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);
    newAttachments.forEach((a) => uploadFile(a.id, a.file));

    e.target.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const stillUploading = attachments.some((a) => a.status === "uploading");
    if (stillUploading) return; // wait for uploads to finish before sending

    if (!input.trim() && attachments.length === 0) return;

    const uploadedDocs = attachments.filter((a) => a.status === "done");

    const label =
      uploadedDocs.length > 0
        ? [
          input.trim(),
          `[Referencing ${uploadedDocs.length} uploaded document(s): ${uploadedDocs
            .map((a) => a.file.name)
            .join(", ")}]`,
        ]
          .filter(Boolean)
          .join(" ")
        : input;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: label,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setAttachments([]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: label,
          documentIds: uploadedDocs.map((a) => a.documentId).filter(Boolean),
        }),
      });

      if (!res.ok) throw new Error(`Request failed: ${res.status}`);

      const data = await res.json();

      if (!sessionId && data.sessionId) {
        setSessionId(data.sessionId);
        loadSessions();
      }

      setMessages((prev) => [
        ...prev,
        {
          id: data.message.id,
          role: data.message.role,
          content: data.message.content,
        },
      ]);
    } catch (err) {
      console.error("Failed to send message", err);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Something went wrong sending that message. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // --- Voice mode ---
  const openVoice = () => {
    setVoiceOpen(true);
    setVoiceState("listening");
  };

  const closeVoice = () => {
    setVoiceOpen(false);
    setVoiceState("idle");
  };

  const cycleVoiceDemo = () => {
    setVoiceState((prev) => {
      if (prev === "listening") return "thinking";
      if (prev === "thinking") return "speaking";
      return "listening";
    });
  };

  const anyUploading = attachments.some((a) => a.status === "uploading");

  return (
    <div className="flex h-screen w-full bg-neutral-900 text-neutral-100 antialiased">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col justify-between border-r border-neutral-800 bg-neutral-950 p-3">
        <div className="flex min-h-0 flex-1 flex-col space-y-3">
          <button
            onClick={handleNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-neutral-700/60 p-2.5 text-sm font-medium transition hover:bg-neutral-800"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            <span className="px-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Recent
            </span>

            {sessionsLoading && (
              <p className="px-2.5 py-2 text-xs text-neutral-500">Loading...</p>
            )}

            {!sessionsLoading && sessions.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-neutral-500">
                No chats yet
              </p>
            )}

            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => loadSessionMessages(s.id)}
                className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-left truncate transition ${s.id === sessionId
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-800/60"
                  }`}
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-neutral-400" />
                <span className="flex-1 truncate">{s.title || "Untitled chat"}</span>
                <span
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  role="button"
                  aria-label="Delete chat"
                  className="shrink-0 rounded p-1 text-neutral-500 opacity-0 hover:text-neutral-200 hover:bg-neutral-700 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-neutral-800 pt-3 flex items-center gap-3 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 font-semibold text-xs text-white">
            U
          </div>
          <div className="truncate text-xs">
            <p className="font-medium text-neutral-200">user@example.com</p>
            <p className="text-neutral-500">Free Tier</p>
          </div>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex flex-1 flex-col h-full relative overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b border-neutral-800/80 px-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-emerald-400" />
            <span className="font-semibold text-sm">Voice RAG Assistant</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && !loading && (
              <div className="flex h-full flex-col items-center justify-center pt-20 text-center text-neutral-500">
                <Bot className="mb-3 h-8 w-8 text-neutral-600" />
                <p className="text-sm">Ask a question, or attach a document to ground answers in it.</p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-4 ${msg.role === "assistant" ? "items-start" : "items-start flex-row-reverse"
                  }`}
              >
                <div
                  className={`flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg ${msg.role === "assistant"
                      ? "bg-emerald-600 text-white"
                      : "bg-neutral-700 text-neutral-200"
                    }`}
                >
                  {msg.role === "assistant" ? (
                    <Bot className="h-5 w-5" />
                  ) : (
                    <User className="h-5 w-5" />
                  )}
                </div>

                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed max-w-[85%] ${msg.role === "user"
                      ? "bg-neutral-800 text-neutral-100 rounded-tr-none"
                      : "bg-neutral-950/70 border border-neutral-800 text-neutral-200 rounded-tl-none shadow-sm"
                    }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex gap-4 items-center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="flex space-x-1.5 py-2">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.3s]" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.15s]" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-neutral-500" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Prompt Input Form */}
        <div className="p-4 bg-gradient-to-t from-neutral-900 via-neutral-900 to-transparent">
          <div className="mx-auto max-w-3xl">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${a.status === "error"
                        ? "border-red-800 bg-red-950/40 text-red-300"
                        : "border-neutral-700 bg-neutral-800 text-neutral-200"
                      }`}
                  >
                    {a.status === "uploading" && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
                    )}
                    {a.status === "done" && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    )}
                    {a.status === "error" && (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                    )}
                    <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                    <span className="max-w-[140px] truncate">{a.file.name}</span>
                    {a.status === "done" && a.chunkCount != null && (
                      <span className="text-neutral-500">· {a.chunkCount} chunks</span>
                    )}
                    {a.status === "error" && (
                      <span>· failed</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.file.name}`}
                      className="ml-1 rounded-full p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="relative flex items-end gap-1 rounded-2xl bg-neutral-800/80 border border-neutral-700/60 shadow-lg focus-within:border-neutral-500 transition-all px-1.5"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach document"
                className="mb-2.5 shrink-0 rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-700 hover:text-neutral-200"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                rows={1}
                placeholder="Message the assistant..."
                className="w-full resize-none bg-transparent px-2 py-3 text-sm text-neutral-100 placeholder-neutral-400 focus:outline-none max-h-32"
              />

              <button
                type="button"
                onClick={openVoice}
                aria-label="Start voice chat"
                className="mb-2.5 shrink-0 rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-700 hover:text-neutral-200"
              >
                <Mic className="h-4 w-4" />
              </button>

              <button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || loading || anyUploading}
                aria-label="Send message"
                className="mb-2 mr-1 shrink-0 rounded-lg bg-neutral-100 p-1.5 text-neutral-900 transition hover:bg-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
            <p className="mt-2 text-center text-[11px] text-neutral-500">
              AI can make mistakes. Verify important info.
            </p>
          </div>
        </div>

        {/* Live Voice Overlay */}
        {voiceOpen && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-8 bg-neutral-950/95 backdrop-blur-sm">
            <button
              onClick={closeVoice}
              aria-label="Close voice chat"
              className="absolute right-5 top-5 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <X className="h-5 w-5" />
            </button>

            <button
              onClick={cycleVoiceDemo}
              className="flex h-40 w-40 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900"
              aria-label="Voice state (demo — click to cycle)"
            >
              <div className="flex items-end gap-1.5">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`w-1.5 rounded-full bg-emerald-400 transition-all duration-300 ${voiceState === "listening"
                        ? "animate-pulse"
                        : voiceState === "speaking"
                          ? "animate-bounce"
                          : ""
                      }`}
                    style={{
                      height:
                        voiceState === "thinking"
                          ? "10px"
                          : `${16 + ((i * 7) % 24)}px`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            </button>

            <div className="text-center">
              <p className="text-sm font-medium text-neutral-200">
                {voiceState === "listening" && "Listening..."}
                {voiceState === "thinking" && "Thinking..."}
                {voiceState === "speaking" && "Speaking — say something to interrupt"}
                {voiceState === "idle" && "Ready"}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Tap the orb to preview states (demo only)
              </p>
            </div>

            <button
              onClick={closeVoice}
              className="flex items-center gap-2 rounded-full border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              End voice chat
            </button>
          </div>
        )}
      </main>
    </div>
  );
}