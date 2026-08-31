"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Radio } from "lucide-react";
import { useVoiceRecorder, VOICE_BAR_COUNT } from "@/src/hooks/useVoiceRecorder";
import { useAudioHistory } from "@/src/hooks/useAudioHistory";
import { useProgressiveAudioPlayer } from "@/src/hooks/useProgressiveAudioPlayer";
import { useLiveConversation, LivePhase } from "@/src/hooks/useLiveConversation";
import { ChatSidebar, Session } from "@/src/components/chat/ChatSidebar";
import { ChatMessageItem, ChatLoadingDots, Message } from "@/src/components/chat/ChatMessageItem";
import { ChatInput } from "@/src/components/chat/ChatInput";
import { LiveModeBar } from "@/src/components/chat/LiveModeBar";
import { Attachment } from "@/src/components/chat/AttachmentList";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // ---- refs that need to exist before any hook/callback below references them ----
  const abortControllerRef = useRef<AbortController | null>(null);
  const ttsQueuedThisTurnRef = useRef(false);
  const liveModeRef = useRef(false);
  const sentenceBufferRef = useRef("");
  // Holds the live-conversation controller so earlier-declared callbacks can
  // reach it without a temporal-dead-zone reference to `liveConversation`.
  const liveConversationRef = useRef<ReturnType<typeof useLiveConversation> | null>(null);

  // Fires when the progressive TTS player finishes ALL queued audio for a turn.
  const handleAssistantFinishedSpeaking = useCallback(() => {
    if (liveModeRef.current) {
      liveConversationRef.current?.resumeListening();
    }
  }, []);

  const {
    isPlaying: isPlayingAssistantAudio,
    queueSentenceForTTS,
    markStreamDone,
    stopAll: stopAssistantSpeech,
  } = useProgressiveAudioPlayer({
    onAllPlaybackEnded: handleAssistantFinishedSpeaking,
  });

  // Now that stopAssistantSpeech exists, it's safe to reference it here.
  const handleBargeIn = useCallback(() => {
    stopAssistantSpeech();
    sentenceBufferRef.current = "";
    abortControllerRef.current?.abort();
    setLoading(false);
    setIsStreaming(false);
  }, [stopAssistantSpeech]);

  // Voice recording (manual push-to-talk, unchanged from before)
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(VOICE_BAR_COUNT).fill(0.05));
  const { record, stop: stopRecording, cancel: cancelRecording } = useVoiceRecorder();
  const recordingPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const audioHistory = useAudioHistory(levels, 46, isRecording);

  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    stopAssistantSpeech();
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
    stopAssistantSpeech();
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

  const uploadFile = async (attachmentId: string, file: File) => {
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/documents", { method: "POST", body: formData });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();

      setAttachments((prev) =>
        prev.map((a) =>
          a.id === attachmentId
            ? { ...a, status: "done", documentId: data.document?.id, chunkCount: data.chunkCount }
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

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const sendMessage = async (text: string, uploadedDocs: Attachment[] = [], enableTTS = true) => {
    if (loading || isStreaming) return;
    if (!text.trim() && uploadedDocs.length === 0) return;

    // Barge-in: interrupt previous speech / previous in-flight request
    stopAssistantSpeech();
    sentenceBufferRef.current = "";
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const label =
      uploadedDocs.length > 0
        ? [
          text.trim(),
          `[Referencing ${uploadedDocs.length} uploaded document(s): ${uploadedDocs
            .map((a) => a.file.name)
            .join(", ")}]`,
        ]
          .filter(Boolean)
          .join(" ")
        : text;

    const userMessage: Message = { id: Date.now().toString(), role: "user", content: label };
    const streamingId = `streaming-${Date.now()}`;

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setAttachments([]);
    setLoading(true);

    let hasCreatedAssistantBubble = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: label,
          documentIds: uploadedDocs.map((a) => a.documentId).filter(Boolean),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.type === "meta") {
            if (!sessionId && event.sessionId) {
              setSessionId(event.sessionId);
              loadSessions();
            }
          }

          if (event.type === "token") {
            if (!hasCreatedAssistantBubble) {
              hasCreatedAssistantBubble = true;
              setLoading(false);
              setIsStreaming(true);
              setMessages((prev) => [
                ...prev,
                {
                  id: streamingId,
                  role: "assistant",
                  content: event.content,
                  grounded: event.grounded,
                  sourceCount: event.sourceCount,
                },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingId ? { ...m, content: m.content + event.content } : m
                )
              );
            }

            // Progressive TTS: parse full sentences as they complete
            if (enableTTS) {
              sentenceBufferRef.current += event.content;
              const match = sentenceBufferRef.current.match(/^([^.!?\n]+[.!?\n]+)([\s\S]*)$/);
              if (match) {
                const completeSentence = match[1].replace(/[*#_`]/g, "").trim();
                sentenceBufferRef.current = match[2];
                if (completeSentence) {
                  ttsQueuedThisTurnRef.current = true;
                  queueSentenceForTTS(completeSentence);
                }
              }
            }
          }

          if (event.type === "done") {
            if (enableTTS && sentenceBufferRef.current.trim()) {
              const remainingText = sentenceBufferRef.current.replace(/[*#_`]/g, "").trim();
              if (remainingText) {
                ttsQueuedThisTurnRef.current = true;
                queueSentenceForTTS(remainingText);
              }
              sentenceBufferRef.current = "";
            }
            markStreamDone();

            setMessages((prev) =>
              prev.map((m) => (m.id === streamingId ? { ...m, id: event.messageId } : m))
            );
          }

          if (event.type === "error") {
            setLoading(false);
            setIsStreaming(false);
            stopAssistantSpeech();
            setMessages((prev) => [
              ...prev.filter((m) => m.id !== streamingId),
              {
                id: streamingId,
                role: "assistant",
                content: "Something went wrong generating a response.",
              },
            ]);
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // Barged in — partial reply (if any) stays as-is, nothing more to do.
        return;
      }
      console.error("Failed to send message", err);
      stopAssistantSpeech();
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== streamingId),
        {
          id: streamingId,
          role: "assistant",
          content: "Something went wrong sending that message. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
      setIsStreaming(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (attachments.some((a) => a.status === "uploading")) return;
    const uploadedDocs = attachments.filter((a) => a.status === "done");
    await sendMessage(input, uploadedDocs, true);
  };

  const transcribe = async (blob: Blob): Promise<string | null> => {
    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append("audio", blob, "voice.webm");
      const res = await fetch("/api/stt", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `STT request failed (${res.status})`);
      }

      // Explicitly check for undefined/null rather than falsy empty string ""
      if (typeof data.transcript !== "string") {
        return null;
      }

      return data.transcript.trim();
    } catch (err) {
      console.error("Transcription failed", err);
      return null;
    } finally {
      setIsTranscribing(false);
    }
  };

  // Manual push-to-talk (used when NOT in live mode)
  const startRecording = () => {
    stopAssistantSpeech();
    sentenceBufferRef.current = "";

    setIsRecording(true);
    setLevels(Array(VOICE_BAR_COUNT).fill(0.05));
    recordingPromiseRef.current = record((bars) => setLevels(bars));
  };

  const handleStopToInput = async () => {
    stopRecording();
    const blob = await recordingPromiseRef.current;
    setIsRecording(false);
    if (!blob) return;
    const transcript = await transcribe(blob);
    if (transcript) setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
  };

  const handleStopAndSend = async () => {
    stopRecording();
    const blob = await recordingPromiseRef.current;
    setIsRecording(false);
    if (!blob) return;
    const transcript = await transcribe(blob);
    if (transcript) await sendMessage(transcript, [], true);
  };

  const handleCancelRecording = async () => {
    cancelRecording();
    await recordingPromiseRef.current;
    setIsRecording(false);
    setIsTranscribing(false);
  };

  // ---- Live (hands-free, full-duplex) mode ----
  const handleLiveUtterance = useCallback(async (blob: Blob, turnId: number) => {
    const transcript = await transcribe(blob);
    if (!liveConversationRef.current?.isTurnCurrent(turnId)) return; // superseded by a newer barge-in

    if (!transcript || !transcript.trim()) {
      liveConversationRef.current?.resumeListening();
      return;
    }

    ttsQueuedThisTurnRef.current = false;
    await sendMessage(transcript, [], true);

    if (!liveConversationRef.current?.isTurnCurrent(turnId)) return;
    // If nothing ever got queued for TTS (empty reply, TTS failure), the
    // player's onAllPlaybackEnded will never fire — resume listening ourselves.
    if (!ttsQueuedThisTurnRef.current) {
      liveConversationRef.current?.resumeListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveConversation = useLiveConversation({
    onUtterance: handleLiveUtterance,
    onBargeIn: handleBargeIn,
  });

  // Keep the ref in sync every render so earlier-declared callbacks can reach
  // the latest controller instance without a stale closure.
  liveConversationRef.current = liveConversation;

  const toggleLiveMode = async () => {
    if (liveConversation.phase === "off") {
      stopAssistantSpeech();
      setInput("");
      liveModeRef.current = true;
      await liveConversation.start();
    } else {
      liveModeRef.current = false;
      liveConversation.stop();
      stopAssistantSpeech();
      abortControllerRef.current?.abort();
    }
  };

  const anyUploading = attachments.some((a) => a.status === "uploading");
  const isBusy = loading || isStreaming;
  const isLive = liveConversation.phase !== "off";
  const currentSessionTitle = sessions.find((s) => s.id === sessionId)?.title || "New chat";

  return (
    <div className="flex h-screen w-full bg-neutral-950 text-neutral-100 antialiased selection:bg-neutral-800">
      <ChatSidebar
        sessions={sessions}
        sessionId={sessionId}
        sessionsLoading={sessionsLoading}
        onNewChat={handleNewChat}
        onSelectSession={loadSessionMessages}
        onDeleteSession={handleDeleteSession}
      />

      <main className="flex flex-1 flex-col h-full relative overflow-hidden bg-neutral-900/40">
        <header className="flex h-14 items-center justify-between border-b border-neutral-800/80 px-6 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm tracking-tight">Voice RAG Assistant</span>
          </div>

          <div className="flex items-center gap-3">
            {sessionId && (
              <span className="max-w-[240px] truncate text-xs text-neutral-500 font-normal">
                {currentSessionTitle}
              </span>
            )}
            <button
              type="button"
              onClick={toggleLiveMode}
              aria-pressed={isLive}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition cursor-pointer ${isLive
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                : "bg-neutral-800/80 text-neutral-300 border border-neutral-700/50 hover:bg-neutral-700"
                }`}
            >
              <Radio className={`h-3.5 w-3.5 ${isLive ? "animate-pulse" : ""}`} />
              {isLive ? "Live" : "Go live"}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.length === 0 && !loading && (
              <div className="flex h-full flex-col items-center justify-center space-y-4 pt-24 text-center text-neutral-500 select-none">
                <p className="text-4xl font-medium text-neutral-400">Where should we begin?</p>
                <p className="text-xs text-neutral-600 mt-1 max-w-xs">
                  Ask questions directly, attach documents to ground responses, or hit{" "}
                  <span className="text-neutral-400">Go live</span> for hands-free voice chat.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <ChatMessageItem key={msg.id} message={msg} />
            ))}

            {loading && <ChatLoadingDots />}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {isLive ? (
          <div className="p-4 bg-gradient-to-t from-neutral-950 via-neutral-950 to-transparent mb-5">
            <div className="mx-auto max-w-3xl">
              <LiveModeBar phase={liveConversation.phase} onEnd={toggleLiveMode} />
            </div>
          </div>
        ) : (
          <ChatInput
            input={input}
            setInput={setInput}
            onSubmit={handleSubmit}
            onFileSelect={handleFileSelect}
            onRemoveAttachment={handleRemoveAttachment}
            attachments={attachments}
            isRecording={isRecording}
            isTranscribing={isTranscribing}
            isPlayingAssistantAudio={isPlayingAssistantAudio}
            onStopAssistantAudio={stopAssistantSpeech}
            isBusy={isBusy}
            anyUploading={anyUploading}
            audioHistory={audioHistory}
            onStartRecording={startRecording}
            onCancelRecording={handleCancelRecording}
            onStopToInput={handleStopToInput}
            onStopAndSend={handleStopAndSend}
          />
        )}
      </main>
    </div>
  );
}