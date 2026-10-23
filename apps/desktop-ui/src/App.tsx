import React, { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Send,
  Square,
  Mic,
  MicOff,
  Radio,
  Volume2,
  VolumeX,
  Plus,
  MessageSquare,
  FileText,
  CheckCircle2,
  Settings,
  Lightbulb,
  Brain,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  X,
  Cpu,
  Shield,
  RotateCcw,
  Loader2
} from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  latencyMs?: number;
  tokPerSec?: number;
  tokensGenerated?: number;
  timestamp?: string;
  isError?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  preview: string;
  timestamp: string;
  messages: Message[];
}

export function App() {
  // Navigation & View
  const [currentView, setCurrentView] = useState<"chat" | "documents" | "tasks">("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Chat State
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: "session-default",
      title: "Current Session",
      preview: "General assistance and reasoning",
      timestamp: "Just now",
      messages: []
    }
  ]);
  const [activeSessionId, setActiveSessionId] = useState("session-default");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Model & Server Config
  const [model, setModel] = useState("nexus:latest");
  const [gatewayUrl, setGatewayUrl] = useState("http://127.0.0.1:3000");
  const [temperature, setTemperature] = useState(0.1);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "checking">("checking");

  // Voice & Audio State
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [userSubtitle, setUserSubtitle] = useState("");
  const [assistantSubtitle, setAssistantSubtitle] = useState("");
  const [voiceAutoListen, setVoiceAutoListen] = useState(true);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceInputDraft, setVoiceInputDraft] = useState("");
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  // UI Utilities & Lifecycle Refs
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const latestTranscriptRef = useRef<string>("");
  const voiceModeActiveRef = useRef<boolean>(false);
  const voiceAutoListenRef = useRef<boolean>(true);
  const isRecordingRef = useRef<boolean>(false);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    voiceModeActiveRef.current = voiceModeActive;
  }, [voiceModeActive]);

  useEffect(() => {
    voiceAutoListenRef.current = voiceAutoListen;
  }, [voiceAutoListen]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Check Gateway Health & Connectivity on mount
  useEffect(() => {
    checkGatewayHealth();
    const interval = setInterval(checkGatewayHealth, 15000);
    return () => clearInterval(interval);
  }, [gatewayUrl]);

  const checkGatewayHealth = async () => {
    try {
      const res = await fetch(`${gatewayUrl}/health`);
      if (res.ok) {
        setConnectionStatus("connected");
      } else {
        setConnectionStatus("disconnected");
      }
    } catch {
      setConnectionStatus("disconnected");
    }
  };

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // Adjust textarea height dynamically
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [input]);

  // Sync messages with active conversation
  useEffect(() => {
    const current = conversations.find((c) => c.id === activeSessionId);
    if (current) {
      setMessages(current.messages);
    }
  }, [activeSessionId]);

  const updateCurrentSessionMessages = (newMessages: Message[]) => {
    setMessages(newMessages);
    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id === activeSessionId) {
          const firstUserMsg = newMessages.find((m) => m.role === "user");
          const title = firstUserMsg
            ? firstUserMsg.content.slice(0, 28) + (firstUserMsg.content.length > 28 ? "..." : "")
            : "New Chat";
          const lastMsg = newMessages[newMessages.length - 1];
          const preview = lastMsg ? lastMsg.content.slice(0, 40) + "..." : "Empty conversation";
          return {
            ...conv,
            title: conv.messages.length === 0 ? title : conv.title,
            preview,
            messages: newMessages
          };
        }
        return conv;
      })
    );
  };

  const handleNewChat = () => {
    const newId = `session-${Date.now()}`;
    const newConv: Conversation = {
      id: newId,
      title: "New Chat",
      preview: "Empty conversation",
      timestamp: "Just now",
      messages: []
    };
    setConversations((prev) => [newConv, ...prev]);
    setActiveSessionId(newId);
    setMessages([]);
    setInput("");
    setErrorMessage(null);
    setCurrentView("chat");
  };

  // Send Message to Chat Gateway
  const handleSend = async (overridePrompt?: string) => {
    const textToSend = (overridePrompt ?? input).trim();
    if (!textToSend || isStreaming) return;

    setErrorMessage(null);
    setUserSubtitle(textToSend);
    setAssistantSubtitle("");
    if (voiceModeActiveRef.current) {
      setVoiceStatus("thinking");
    }

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };

    const nextMessages = [...messages, userMsg];
    updateCurrentSessionMessages(nextMessages);
    if (!overridePrompt) setInput("");
    setIsStreaming(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const t0 = performance.now();

    try {
      const res = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
          model,
          temperature,
          sessionId: activeSessionId
        })
      });

      if (!res.ok) {
        throw new Error(`Gateway returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      const latencyMs = Math.round(performance.now() - t0);

      // Extract conversational text
      let assistantText = "";
      if (typeof data.message?.content === "string" && data.message.content.trim()) {
        assistantText = data.message.content.trim();
      } else if (typeof data.parsedOutput?.content === "string" && data.parsedOutput.content.trim()) {
        assistantText = data.parsedOutput.content.trim();
      } else {
        throw new Error("Received empty response from assistant.");
      }

      const assistantMsg: Message = {
        id: `msg-${Date.now() + 1}`,
        role: "assistant",
        content: assistantText,
        latencyMs: data.latencyMs || latencyMs,
        tokPerSec: data.tokPerSec,
        tokensGenerated: data.tokensGenerated,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        isError: data.isError
      };

      updateCurrentSessionMessages([...nextMessages, assistantMsg]);
      setAssistantSubtitle(assistantText);

      // Direct Browser Launcher for YouTube & Media URLs (Option 1)
      const ytMatch = assistantText.match(/https?:\/\/(?:www\.)?youtube\.com\/[^\s\)]+/);
      if (ytMatch) {
        try {
          window.open(ytMatch[0], "_blank", "noopener,noreferrer");
        } catch {}
      }

      // If dedicated voice mode is open or voice was used, speak the answer
      if ((voiceModeActiveRef.current || overridePrompt) && "speechSynthesis" in window) {
        speakResponse(assistantText);
      } else if (voiceModeActiveRef.current) {
        setVoiceStatus("idle");
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        // User deliberately stopped generation
        const stoppedMsg: Message = {
          id: `msg-${Date.now() + 1}`,
          role: "assistant",
          content: "*(Generation stopped by user)*",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        };
        updateCurrentSessionMessages([...nextMessages, stoppedMsg]);
      } else {
        // Show error and preserve input so user can retry
        const errText = err.message || "Failed to reach inference gateway.";
        setErrorMessage(errText);
        if (voiceModeActiveRef.current) {
          setVoiceStatus("idle");
          setAssistantSubtitle(`Error: ${errText}`);
        }
        if (!overridePrompt && !input) {
          setInput(textToSend); // Retain input on failure
        }
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Web Speech API - Microphone Recognition & Voice Pipeline
  const startSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError("Speech recognition is not supported in this browser. Please use Chrome, Edge, or a supported Chromium browser.");
      return;
    }

    // Cancel active TTS speech to prevent microphone hearing assistant audio
    if ("speechSynthesis" in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setVoiceStatus("idle");
    }

    try {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.abort();
        } catch {}
      }

      setVoiceError(null);
      latestTranscriptRef.current = "";
      setVoiceTranscript("");

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        setIsRecording(true);
        isRecordingRef.current = true;
        setVoiceStatus("listening");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        const text = (final || interim || "").trim();
        if (text) {
          latestTranscriptRef.current = text;
          setVoiceTranscript(text);
          setUserSubtitle(text);
          setInput(text);
        }
      };

      recognition.onerror = (event: any) => {
        setIsRecording(false);
        isRecordingRef.current = false;
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setVoiceError("Microphone access was denied. Please allow microphone permissions in your browser address bar.");
          setVoiceStatus("idle");
        } else if (event.error === "no-speech") {
          if (!latestTranscriptRef.current.trim()) {
            setVoiceStatus("idle");
          }
        } else if (event.error !== "aborted") {
          setVoiceError(`Microphone notice: ${event.error}`);
          setVoiceStatus("idle");
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
        isRecordingRef.current = false;
        const textToSubmit = latestTranscriptRef.current.trim();
        if (textToSubmit) {
          setUserSubtitle(textToSubmit);
          setAssistantSubtitle("");
          setVoiceStatus("thinking");
          latestTranscriptRef.current = "";
          handleSend(textToSubmit);
        } else {
          setVoiceStatus("idle");
        }
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
    } catch (err: any) {
      setIsRecording(false);
      isRecordingRef.current = false;
      setVoiceStatus("idle");
      setVoiceError(`Failed to initialize microphone: ${err.message}`);
    }
  };

  const stopSpeechRecognition = () => {
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch {}
    }
    setIsRecording(false);
    isRecordingRef.current = false;
    setVoiceStatus("idle");
  };

  const toggleSpeechRecognition = () => {
    if (isRecording) {
      stopSpeechRecognition();
    } else {
      startSpeechRecognition();
    }
  };

  // Immediate manual submission of recognized voice text
  const handleVoiceSubmit = () => {
    const textToSubmit = (voiceTranscript || latestTranscriptRef.current || input).trim();
    if (!textToSubmit) return;
    stopSpeechRecognition();
    setUserSubtitle(textToSubmit);
    setAssistantSubtitle("");
    setVoiceStatus("thinking");
    latestTranscriptRef.current = "";
    setVoiceTranscript("");
    handleSend(textToSubmit);
  };

  // Text input fallback inside Voice Mode modal
  const handleVoiceDraftSubmit = () => {
    const text = voiceInputDraft.trim();
    if (!text) return;
    setVoiceInputDraft("");
    setUserSubtitle(text);
    setAssistantSubtitle("");
    setVoiceStatus("thinking");
    handleSend(text);
  };

  // Text-to-Speech Playback with Subtitle Tracking & Continuous Conversation
  const speakResponse = (text: string, msgId?: string) => {
    if (!("speechSynthesis" in window)) return;

    if (speakingMessageId === msgId && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setSpeakingMessageId(null);
      setVoiceStatus("idle");
      return;
    }

    if (isRecordingRef.current) {
      stopSpeechRecognition();
    }

    window.speechSynthesis.cancel();
    setVoiceStatus("speaking");
    setAssistantSubtitle(text);
    if (msgId) setSpeakingMessageId(msgId);

    // Clean markdown symbols for natural TTS speech
    const cleanSpeech = text
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`{1,3}[\s\S]*?`{1,3}/g, "code block")
      .replace(/#+\s/g, "")
      .replace(/\[TOOL RESULT[\s\S]*?\]/gi, "")
      .replace(/https?:\/\/\S+/g, "link");

    const utterance = new SpeechSynthesisUtterance(cleanSpeech);
    currentUtteranceRef.current = utterance;
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    // Pick best natural voice if available
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.includes("Natural") ||
          v.name.includes("Google") ||
          v.name.includes("Jenny") ||
          v.name.includes("Guy") ||
          v.name.includes("Aria"))
    );
    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    utterance.onend = () => {
      setSpeakingMessageId(null);
      currentUtteranceRef.current = null;
      setVoiceStatus("idle");

      // Auto-listen loop: automatically listen for user's next question in Voice Mode
      if (voiceModeActiveRef.current && voiceAutoListenRef.current) {
        setTimeout(() => {
          if (voiceModeActiveRef.current && !isRecordingRef.current) {
            startSpeechRecognition();
          }
        }, 500);
      }
    };

    utterance.onerror = () => {
      setSpeakingMessageId(null);
      currentUtteranceRef.current = null;
      setVoiceStatus("idle");
    };

    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Suggestion Card Handler
  const handleSuggestion = (prompt: string) => {
    setInput(prompt);
    handleSend(prompt);
  };

  // Render markdown-like simple paragraphs and code snippets
  const renderFormattedContent = (content: string) => {
    const parts = content.split(/(```[\s\S]*?```)/g);
    return (
      <div className="prose-nexus space-y-2">
        {parts.map((part, index) => {
          if (part.startsWith("```") && part.endsWith("```")) {
            const lines = part.slice(3, -3).trim().split("\n");
            const firstLine = lines[0].trim();
            const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
            const lang = hasLang ? firstLine : "";
            const code = hasLang ? lines.slice(1).join("\n") : lines.join("\n");

            return (
              <div key={index} className="relative my-3 rounded-lg overflow-hidden border border-slate-800 bg-[#0c121e]">
                {lang && (
                  <div className="px-3 py-1 bg-slate-900/80 border-b border-slate-800 text-[11px] font-mono text-slate-400 uppercase tracking-wider flex justify-between items-center">
                    <span>{lang}</span>
                    <button
                      onClick={() => copyToClipboard(code, `code-${index}`)}
                      className="text-slate-400 hover:text-white transition-colors"
                    >
                      {copiedId === `code-${index}` ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
                <pre className="p-3 text-xs md:text-sm font-mono text-slate-200 overflow-x-auto leading-relaxed">
                  <code>{code}</code>
                </pre>
              </div>
            );
          }

          // Plain text with bold, links, and YouTube card rendering
          const paragraphs = part.split("\n\n");
          return (
            <div key={index} className="space-y-2">
              {paragraphs.map((p, pIdx) => {
                if (!p.trim()) return null;
                const formatted = p
                  .split(/(\*\*.*?\*\*|\[.*?\]\(https?:\/\/.*?\))/g)
                  .map((chunk, cIdx) => {
                    if (chunk.startsWith("**") && chunk.endsWith("**")) {
                      return (
                        <strong key={cIdx} className="font-semibold text-slate-100">
                          {chunk.slice(2, -2)}
                        </strong>
                      );
                    }
                    const linkMatch = chunk.match(/^\[(.*?)\]\((https?:\/\/.*?)\)$/);
                    if (linkMatch) {
                      const [, label, url] = linkMatch;
                      const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
                      if (isYouTube) {
                        return (
                          <span key={cIdx} className="block my-2">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2.5 px-4 py-2 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-red-700 hover:from-red-500 hover:to-rose-500 text-white font-medium text-xs sm:text-sm shadow-lg shadow-red-600/25 border border-red-500/40 transition-all hover:scale-[1.02] cursor-pointer no-underline"
                            >
                              <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-bold shadow-inner">
                                ▶
                              </span>
                              <span>{label}</span>
                            </a>
                          </span>
                        );
                      }
                      return (
                        <a
                          key={cIdx}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 underline font-medium"
                        >
                          {label}
                        </a>
                      );
                    }
                    return chunk;
                  });

                return (
                  <p key={pIdx} className="text-slate-200 text-sm md:text-[15px] leading-relaxed whitespace-pre-line">
                    {formatted}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex h-screen w-screen bg-[#0B0F17] text-slate-100 overflow-hidden font-sans selection:bg-purple-500/30 selection:text-white">
      {/* ========================================================================= */}
      {/* 1. COLLAPSIBLE SIDEBAR */}
      {/* ========================================================================= */}
      <aside
        className={`flex flex-col bg-[#0e1422] border-r border-slate-800/80 transition-all duration-300 z-20 ${
          sidebarOpen ? "w-64 min-w-[16rem]" : "w-0 min-w-0 -translate-x-full md:translate-x-0 md:w-16 md:min-w-[4rem]"
        }`}
      >
        {/* Sidebar Header & Brand */}
        <div className="h-14 flex items-center justify-between px-3 border-b border-slate-800/60">
          {sidebarOpen ? (
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-md shadow-cyan-500/20">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <span className="font-semibold text-sm tracking-wider bg-gradient-to-r from-cyan-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
                NEXUS
              </span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
                V2.3
              </span>
            </div>
          ) : (
            <div className="mx-auto">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-md">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
            </div>
          )}

          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={handleNewChat}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-slate-700/60 bg-gradient-to-r from-slate-800/90 to-slate-800/40 hover:from-indigo-600/20 hover:to-cyan-600/20 hover:border-indigo-500/40 text-slate-200 text-xs font-medium transition-all shadow-sm ${
              !sidebarOpen && "justify-center px-0"
            }`}
            title="Start a new conversation"
          >
            <Plus className="w-4 h-4 text-cyan-400 flex-shrink-0" />
            {sidebarOpen && <span>New chat</span>}
          </button>
        </div>

        {/* Navigation Tabs */}
        <nav className="px-3 py-1 space-y-1">
          <button
            onClick={() => setCurrentView("chat")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              currentView === "chat"
                ? "bg-indigo-600/15 text-cyan-300 border border-indigo-500/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            } ${!sidebarOpen && "justify-center px-0"}`}
            title="Chat conversation"
          >
            <MessageSquare className="w-4 h-4 flex-shrink-0" />
            {sidebarOpen && <span>Chat</span>}
          </button>

          <button
            onClick={() => setCurrentView("documents")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              currentView === "documents"
                ? "bg-indigo-600/15 text-cyan-300 border border-indigo-500/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            } ${!sidebarOpen && "justify-center px-0"}`}
            title="Project Documents"
          >
            <FileText className="w-4 h-4 flex-shrink-0" />
            {sidebarOpen && <span>Documents</span>}
          </button>

          <button
            onClick={() => setCurrentView("tasks")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              currentView === "tasks"
                ? "bg-indigo-600/15 text-cyan-300 border border-indigo-500/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            } ${!sidebarOpen && "justify-center px-0"}`}
            title="Tasks & Verifications"
          >
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            {sidebarOpen && <span>Tasks</span>}
          </button>
        </nav>

        {/* Recent Conversations List */}
        {sidebarOpen && (
          <div className="flex-1 overflow-y-auto px-3 py-3 border-t border-slate-800/40">
            <div className="text-[11px] font-semibold text-slate-400 tracking-wider uppercase px-2 mb-2">
              Recent Chats
            </div>
            <div className="space-y-1">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    setActiveSessionId(conv.id);
                    setCurrentView("chat");
                  }}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors flex flex-col gap-0.5 ${
                    activeSessionId === conv.id
                      ? "bg-slate-800/80 text-white"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                  }`}
                >
                  <span className="font-medium truncate">{conv.title}</span>
                  <span className="text-[10px] text-slate-500 truncate">{conv.preview}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sidebar Footer: Sovereign Local Status */}
        <div className="p-3 border-t border-slate-800/60 mt-auto">
          {sidebarOpen ? (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400">
              <Shield className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
              <div className="truncate">
                <span className="text-slate-200 font-medium block">100% Sovereign</span>
                <span className="text-[10px] text-slate-500">Zero Cloud API Calls</span>
              </div>
            </div>
          ) : (
            <div className="flex justify-center" title="100% Sovereign Local Inference">
              <Shield className="w-4 h-4 text-emerald-400" />
            </div>
          )}
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* 2. MAIN WORKSPACE */}
      {/* ========================================================================= */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#101726] via-[#0B0F17] to-[#070A10]">
        {/* Top Bar */}
        <header className="h-14 border-b border-slate-800/60 flex items-center justify-between px-4 md:px-6 backdrop-blur-md bg-[#0B0F17]/70 z-10">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
                title="Open sidebar"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-wide text-slate-200">Project NEXUS</span>
              <span className="text-[11px] text-slate-400 hidden sm:inline">• Sovereign Assistant</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Active Model Selector */}
            <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 rounded-full px-3 py-1 text-xs">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bg-transparent text-slate-300 text-xs focus:outline-none cursor-pointer"
              >
                <option value="nexus:latest" className="bg-[#0e1422] text-slate-200">nexus:latest (Promoted)</option>
                <option value="nexus:0.8b" className="bg-[#0e1422] text-slate-200">nexus:0.8b (LoRA Merged)</option>
                <option value="qwen3.5:0.8b" className="bg-[#0e1422] text-slate-200">qwen3.5:0.8b (Base)</option>
                <option value="qwen3.5:2b-q4_K_M" className="bg-[#0e1422] text-slate-200">qwen3.5:2b-q4_K_M (Quantized)</option>
              </select>
            </div>

            {/* Connection Status Badge */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-800 text-[11px]">
              <span
                className={`w-2 h-2 rounded-full ${
                  connectionStatus === "connected"
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                    : connectionStatus === "checking"
                    ? "bg-amber-400"
                    : "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]"
                }`}
              />
              <span className="text-slate-400">
                {connectionStatus === "connected" ? "Local GPU Online" : connectionStatus === "checking" ? "Checking..." : "Offline"}
              </span>
            </div>

            {/* Settings Button */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
              title="Assistant Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* VIEW 1: CONVERSATION (CHAT) */}
          {currentView === "chat" && (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              {/* Message Scroll Area */}
              <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
                {messages.length === 0 ? (
                  /* Gemini-Inspired Clean Welcome Screen */
                  <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center space-y-8 my-auto">
                    {/* Glowing Subtle Ambient Backlight */}
                    <div className="relative">
                      <div className="absolute -inset-4 bg-gradient-to-r from-cyan-500/10 via-indigo-500/15 to-purple-500/10 rounded-full blur-2xl pointer-events-none" />
                      <h1 className="relative text-3xl md:text-5xl font-light tracking-tight text-slate-100">
                        <span className="bg-gradient-to-r from-cyan-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent font-normal">
                          Hello.
                        </span>{" "}
                        What can we work on?
                      </h1>
                    </div>

                    <p className="text-sm md:text-base text-slate-400 max-w-md">
                      Ask questions, explore your documents, or get things done with your sovereign local AI.
                    </p>

                    {/* 4 Clean Suggestion Cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full text-left pt-2">
                      <button
                        onClick={() =>
                          handleSuggestion("Explain how sovereign local AI preserves data privacy without cloud APIs.")
                        }
                        className="group p-4 rounded-2xl bg-[#121824]/80 border border-slate-800/80 hover:border-cyan-500/40 hover:bg-[#162032] transition-all duration-200 flex flex-col gap-2 shadow-sm"
                      >
                        <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                          <Lightbulb className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-200 group-hover:text-cyan-300 transition-colors">
                            Explain a concept
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">
                            How sovereign AI preserves privacy without cloud leakage.
                          </div>
                        </div>
                      </button>

                      <button
                        onClick={() =>
                          handleSuggestion(
                            "You are outside a closed room with three light switches. Inside the room is a single incandescent bulb. You can only enter the room once. How do you figure out which switch controls the bulb?"
                          )
                        }
                        className="group p-4 rounded-2xl bg-[#121824]/80 border border-slate-800/80 hover:border-purple-500/40 hover:bg-[#162032] transition-all duration-200 flex flex-col gap-2 shadow-sm"
                      >
                        <div className="w-8 h-8 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                          <Brain className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-200 group-hover:text-purple-300 transition-colors">
                            Solve a logic puzzle
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">
                            The 3 light switches and 1 incandescent bulb problem.
                          </div>
                        </div>
                      </button>

                      <button
                        onClick={() =>
                          handleSuggestion(
                            "Summarize the key architectural guarantees and Phase gates in MASTER_PLAN.md."
                          )
                        }
                        className="group p-4 rounded-2xl bg-[#121824]/80 border border-slate-800/80 hover:border-indigo-500/40 hover:bg-[#162032] transition-all duration-200 flex flex-col gap-2 shadow-sm"
                      >
                        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                          <FileText className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-200 group-hover:text-indigo-300 transition-colors">
                            Analyze documents
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">
                            Review Project NEXUS architecture and Phase gates.
                          </div>
                        </div>
                      </button>

                      <button
                        onClick={() =>
                          handleSuggestion(
                            "A company had ₹120,000 in revenue, which then dropped by 20%. What is the new revenue? Show step-by-step calculation."
                          )
                        }
                        className="group p-4 rounded-2xl bg-[#121824]/80 border border-slate-800/80 hover:border-emerald-500/40 hover:bg-[#162032] transition-all duration-200 flex flex-col gap-2 shadow-sm"
                      >
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                          <Calculator className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-200 group-hover:text-emerald-300 transition-colors">
                            Calculate finances
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">
                            Compute 20% compound revenue drop with math steps.
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Centered Readable Chat Column */
                  <div className="max-w-3xl mx-auto space-y-6">
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                      >
                        {/* User Message Bubble */}
                        {msg.role === "user" && (
                          <div className="max-w-[85%] bg-gradient-to-r from-blue-600 via-indigo-600 to-indigo-700 text-white rounded-2xl rounded-tr-sm px-4 py-3 shadow-md shadow-indigo-900/20 text-sm md:text-[15px] leading-relaxed">
                            {msg.content}
                          </div>
                        )}

                        {/* Assistant Message Bubble */}
                        {msg.role === "assistant" && (
                          <div className="max-w-[95%] sm:max-w-[90%] flex gap-3 text-slate-100">
                            {/* Avatar */}
                            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-purple-600 flex items-center justify-center flex-shrink-0 mt-1 shadow-sm shadow-cyan-500/20">
                              <Sparkles className="w-4 h-4 text-white" />
                            </div>

                            {/* Body & Actions */}
                            <div className="flex-1 space-y-2">
                              <div className="bg-[#121824]/60 border border-slate-800/80 rounded-2xl p-4 shadow-sm">
                                {renderFormattedContent(msg.content)}
                              </div>

                              {/* Telemetry & Action Bar */}
                              <div className="flex items-center gap-3 px-2 text-[11px] text-slate-400">
                                {msg.tokPerSec && (
                                  <span className="flex items-center gap-1 text-cyan-400 font-mono">
                                    ⚡ {msg.tokPerSec} tok/s
                                  </span>
                                )}
                                {msg.latencyMs && (
                                  <span className="font-mono">{msg.latencyMs}ms</span>
                                )}
                                {msg.timestamp && <span>{msg.timestamp}</span>}

                                <div className="ml-auto flex items-center gap-1.5">
                                  <button
                                    onClick={() => copyToClipboard(msg.content, msg.id)}
                                    className="p-1 rounded text-slate-400 hover:text-white transition-colors"
                                    title="Copy to clipboard"
                                  >
                                    {copiedId === msg.id ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>

                                  <button
                                    onClick={() => speakResponse(msg.content, msg.id)}
                                    className="p-1 rounded text-slate-400 hover:text-white transition-colors"
                                    title={speakingMessageId === msg.id ? "Stop speech" : "Read aloud"}
                                  >
                                    {speakingMessageId === msg.id ? (
                                      <VolumeX className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                                    ) : (
                                      <Volume2 className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Thinking / Streaming Indicator */}
                    {isStreaming && (
                      <div className="flex items-start gap-3 max-w-[90%] text-slate-300">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-purple-600 flex items-center justify-center flex-shrink-0 animate-pulse">
                          <Sparkles className="w-4 h-4 text-white" />
                        </div>
                        <div className="bg-[#121824]/60 border border-slate-800/80 rounded-2xl px-4 py-3 flex items-center gap-2 text-xs text-slate-400">
                          <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                          <span>NEXUS is thinking...</span>
                        </div>
                      </div>
                    )}

                    {/* Error Banner */}
                    {errorMessage && (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
                        <span>{errorMessage}</span>
                        <button
                          onClick={() => handleSend()}
                          className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 font-medium flex items-center gap-1 transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" /> Retry
                        </button>
                      </div>
                    )}

                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* ========================================================================= */}
              {/* 3. GEMINI-INSPIRED MESSAGE COMPOSER */}
              {/* ========================================================================= */}
              <div className="p-4 md:pb-6 md:pt-2 w-full max-w-3xl mx-auto">
                <div className="relative rounded-3xl bg-[#121824]/90 backdrop-blur-md border border-slate-800 focus-within:border-indigo-500/50 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all duration-200 shadow-xl shadow-black/30 p-2.5">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask NEXUS anything..."
                    rows={1}
                    className="w-full bg-transparent text-slate-100 placeholder-slate-400 text-sm md:text-[15px] px-3 pt-1.5 focus:outline-none resize-none leading-relaxed max-h-40 min-h-[28px]"
                  />

                  {/* Composer Controls Bar */}
                  <div className="flex items-center justify-between pt-1 px-1 mt-1 border-t border-slate-800/50">
                    <div className="flex items-center gap-1">
                      {/* Microphone Push-to-Talk Button */}
                      <button
                        onClick={toggleSpeechRecognition}
                        className={`p-2 rounded-full transition-colors ${
                          isRecording
                            ? "bg-rose-500/20 text-rose-400 animate-pulse border border-rose-500/40"
                            : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                        }`}
                        title={isRecording ? "Stop recording speech" : "Speak input via microphone"}
                      >
                        {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>

                      {/* Waveform / Dedicated Voice Mode Toggle */}
                      <button
                        onClick={() => {
                          setVoiceModeActive(true);
                          setVoiceError(null);
                          setUserSubtitle("");
                          setAssistantSubtitle("");
                          setTimeout(() => {
                            startSpeechRecognition();
                          }, 300);
                        }}
                        className="p-2 rounded-full text-slate-400 hover:text-cyan-400 hover:bg-slate-800/60 transition-colors"
                        title="Open dedicated Voice Conversation mode with Subtitles"
                      >
                        <Radio className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      {isStreaming ? (
                        <button
                          onClick={handleStop}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/30 text-rose-300 text-xs font-medium transition-colors"
                          title="Stop generation"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" /> Stop
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSend()}
                          disabled={!input.trim()}
                          className="p-2 rounded-full bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-95 transition-all shadow-md shadow-indigo-600/20"
                          title="Send message (Enter)"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 2: DOCUMENTS */}
          {currentView === "documents" && (
            <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-slate-100">Project Documents</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Explore indexed documents, specifications, and architecture files for Project NEXUS.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  {
                    title: "MASTER_PLAN.md",
                    badge: "Specification",
                    desc: "V2.3 authoritative system specification, Phase 0–13 roadmaps, and local guardrails.",
                    prompt: "Summarize the architectural principles and phases in MASTER_PLAN.md."
                  },
                  {
                    title: "threat_model.md",
                    badge: "Security",
                    desc: "Threat model, permission boundaries, and sovereign air-gap controls.",
                    prompt: "Explain the threat model and security protections implemented in Project NEXUS."
                  },
                  {
                    title: "execution_status.md",
                    badge: "Telemetry",
                    desc: "Execution status, completed phase milestones, and model verification results.",
                    prompt: "What is the current execution status and which phases are verified?"
                  },
                  {
                    title: "phase0.md",
                    badge: "Benchmarks",
                    desc: "Inference latency, memory footprint, and RTX 4050 baseline benchmarks.",
                    prompt: "Summarize the benchmark findings in phase0.md."
                  }
                ].map((doc, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-2xl bg-[#121824]/80 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between gap-3 shadow-sm"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-xs font-semibold text-cyan-300">{doc.title}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-medium">
                          {doc.badge}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">{doc.desc}</p>
                    </div>

                    <button
                      onClick={() => {
                        setCurrentView("chat");
                        handleSuggestion(doc.prompt);
                      }}
                      className="w-full py-2 rounded-xl bg-slate-800/80 hover:bg-indigo-600/30 hover:border-indigo-500/40 border border-slate-700/60 text-xs font-medium text-slate-200 transition-all flex items-center justify-center gap-1.5"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> Ask NEXUS about this doc
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIEW 3: TASKS & VERIFICATIONS */}
          {currentView === "tasks" && (
            <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-slate-100">Tasks & Phase Verifications</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Authoritative engineering checklist for Project NEXUS V2.3.
                </p>
              </div>

              <div className="space-y-3">
                {[
                  { phase: "Phase 0", title: "ML Environment & CUDA RTX 4050", status: "VERIFIED", color: "text-emerald-400" },
                  { phase: "Phase 1", title: "Model Compatibility Probe & Lineage", status: "VERIFIED", color: "text-emerald-400" },
                  { phase: "Phase 2", title: "LoRA Training & Weights Merging", status: "VERIFIED", color: "text-emerald-400" },
                  { phase: "Phase 3", title: "Inference Gateway & Response Normalizer", status: "VERIFIED", color: "text-emerald-400" },
                  { phase: "Phase 4", title: "Gemini-Inspired Conversational UI", status: "ACTIVE", color: "text-cyan-400" },
                  { phase: "Phase 5", title: "Local Voice Bridge (Whisper / Piper)", status: "OPERATIONAL", color: "text-emerald-400" },
                  { phase: "Phase 6", title: "Sovereign Air-Gap Security Guardrails", status: "VERIFIED", color: "text-emerald-400" }
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-[#121824]/80 border border-slate-800 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className={`w-4 h-4 ${item.color}`} />
                      <div>
                        <span className="font-semibold text-slate-200">{item.phase}:</span>{" "}
                        <span className="text-slate-300">{item.title}</span>
                      </div>
                    </div>
                    <span className={`font-mono text-[11px] font-semibold ${item.color}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* 4. DEDICATED VOICE MODE MODAL WITH LIVE SUBTITLES */}
          {/* ========================================================================= */}
          {voiceModeActive && (
            <div className="absolute inset-0 bg-[#0B0F17]/95 backdrop-blur-2xl z-40 flex flex-col justify-between p-4 sm:p-8 animate-fade-in overflow-hidden">
              {/* Modal Top Bar */}
              <div className="w-full flex items-center justify-between max-w-2xl mx-auto">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-xs font-medium text-slate-200">
                    <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                    <span>NEXUS Voice Live</span>
                  </div>

                  {/* Auto-Listen / Hands-Free Toggle */}
                  <button
                    onClick={() => setVoiceAutoListen((prev) => !prev)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                      voiceAutoListen
                        ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-300"
                        : "bg-slate-800/60 border-slate-700/40 text-slate-400 hover:text-slate-200"
                    }`}
                    title="Toggle continuous hands-free dialogue"
                  >
                    <span>Hands-free:</span>
                    <span className="font-semibold">{voiceAutoListen ? "ON" : "OFF"}</span>
                  </button>
                </div>

                <button
                  onClick={() => {
                    setVoiceModeActive(false);
                    if (window.speechSynthesis) window.speechSynthesis.cancel();
                    stopSpeechRecognition();
                  }}
                  className="p-2 sm:p-2.5 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                  title="Exit Voice Mode"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Center Content: Orb & Live Subtitles */}
              <div className="max-w-2xl w-full mx-auto flex flex-col items-center text-center space-y-4 sm:space-y-6 my-auto overflow-y-auto py-2">
                {/* Visual Pure CSS Gradient Ring (No WebGL!) */}
                <div className="relative flex items-center justify-center">
                  <button
                    onClick={toggleSpeechRecognition}
                    className={`w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-gradient-to-br from-cyan-500/20 via-indigo-500/30 to-purple-500/20 border border-cyan-400/40 flex items-center justify-center transition-all duration-500 focus:outline-none cursor-pointer ${
                      voiceStatus === "listening"
                        ? "animate-voice-pulse border-cyan-400 shadow-lg shadow-cyan-500/20"
                        : voiceStatus === "speaking"
                        ? "animate-voice-pulse border-purple-400 shadow-lg shadow-purple-500/20"
                        : "hover:border-slate-600"
                    }`}
                    title={isRecording ? "Listening (tap to pause)" : "Tap to speak"}
                  >
                    <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[#121824] border border-slate-800 flex items-center justify-center shadow-inner">
                      {voiceStatus === "speaking" ? (
                        <Volume2 className="w-8 h-8 text-purple-400 animate-pulse" />
                      ) : voiceStatus === "thinking" ? (
                        <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                      ) : voiceStatus === "listening" ? (
                        <Mic className="w-8 h-8 text-cyan-400 animate-bounce" />
                      ) : (
                        <Radio className="w-8 h-8 text-indigo-400" />
                      )}
                    </div>
                  </button>
                </div>

                {/* Status Indicator Heading */}
                <div>
                  <h3 className="text-lg sm:text-xl font-semibold text-slate-100 flex items-center justify-center gap-2">
                    {voiceStatus === "listening" && (
                      <span className="text-cyan-300">Listening to you...</span>
                    )}
                    {voiceStatus === "thinking" && (
                      <span className="text-indigo-300 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                        NEXUS is thinking...
                      </span>
                    )}
                    {voiceStatus === "speaking" && (
                      <span className="text-purple-300">NEXUS is speaking...</span>
                    )}
                    {voiceStatus === "idle" && (
                      <span className="text-slate-300">Voice Mode Ready</span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    {voiceStatus === "listening"
                      ? "Speak naturally — your words will automatically send when you finish"
                      : voiceStatus === "thinking"
                      ? "Generating verified response..."
                      : voiceStatus === "speaking"
                      ? "Tap microphone to interrupt or mute"
                      : "Tap microphone or speak naturally to start"}
                  </p>
                </div>

                {/* Voice Error Banner */}
                {voiceError && (
                  <div className="w-full max-w-lg p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-xs text-rose-200 text-left">
                    ⚠️ {voiceError}
                  </div>
                )}

                {/* ================================================================= */}
                {/* SUBTITLES CONTAINER (What I Told & What NEXUS Told) */}
                {/* ================================================================= */}
                <div className="w-full max-w-lg flex flex-col gap-3 text-left">
                  {/* 1. User Subtitle: What I have told */}
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-900/80 border border-cyan-500/30 backdrop-blur-md shadow-lg transition-all">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${isRecording ? "bg-cyan-400 animate-ping" : "bg-cyan-400"}`} />
                        <span className="text-xs font-semibold text-cyan-300 uppercase tracking-wider">
                          You
                        </span>
                      </div>
                      {isRecording && (
                        <span className="text-[10px] text-cyan-400/80 font-mono">live audio</span>
                      )}
                    </div>
                    <p className="text-sm sm:text-[15px] text-slate-100 font-medium leading-relaxed italic">
                      "{userSubtitle || voiceTranscript || (isRecording ? "Listening to your voice..." : "Press microphone to speak...")}"
                    </p>
                  </div>

                  {/* 2. Assistant Subtitle: What NEXUS told */}
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-900/80 border border-purple-500/30 backdrop-blur-md shadow-lg transition-all">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${voiceStatus === "speaking" ? "bg-purple-400 animate-ping" : "bg-purple-400"}`} />
                        <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">
                          NEXUS
                        </span>
                      </div>
                      {voiceStatus === "speaking" && (
                        <span className="text-[10px] text-purple-400 font-mono">speaking</span>
                      )}
                    </div>

                    {voiceStatus === "thinking" ? (
                      <div className="flex items-center gap-2.5 py-1 text-sm text-slate-300 italic">
                        <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                        <span>Formulating answer and preparing speech...</span>
                      </div>
                    ) : (
                      <div className="text-sm sm:text-[15px] text-slate-100 font-normal leading-relaxed max-h-40 overflow-y-auto pr-1">
                        {assistantSubtitle ? (
                          <div className="prose-nexus text-xs sm:text-sm">
                            {renderFormattedContent(assistantSubtitle)}
                          </div>
                        ) : (
                          <p className="italic text-slate-400 text-sm">
                            NEXUS responses will appear as subtitles and be read aloud here.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Voice Controls Action Bar */}
                <div className="flex items-center gap-4 pt-1">
                  {/* Microphone Toggle Button */}
                  <button
                    onClick={toggleSpeechRecognition}
                    className={`p-4 rounded-full transition-all shadow-xl ${
                      isRecording
                        ? "bg-rose-600 text-white shadow-rose-600/40 animate-pulse scale-105"
                        : "bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 text-white shadow-cyan-500/25 hover:scale-105"
                    }`}
                    title={isRecording ? "Mute Microphone" : "Start Speaking"}
                  >
                    {isRecording ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                  </button>

                  {/* Immediate Manual Send Button (if transcript or text is ready) */}
                  {(voiceTranscript || latestTranscriptRef.current || input) && isRecording && (
                    <button
                      onClick={handleVoiceSubmit}
                      className="p-3.5 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white transition-all shadow-lg shadow-cyan-600/30"
                      title="Send now without waiting for pause"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  )}

                  {/* Interrupt / Stop Speech Button */}
                  {voiceStatus === "speaking" && (
                    <button
                      onClick={() => {
                        window.speechSynthesis.cancel();
                        setVoiceStatus("idle");
                      }}
                      className="p-3.5 rounded-full bg-slate-800 hover:bg-rose-900/60 text-slate-200 border border-slate-700 transition-colors"
                      title="Interrupt and stop audio"
                    >
                      <VolumeX className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Bottom Quick-Type Input Fallback inside Voice Modal */}
              <div className="w-full max-w-lg mx-auto">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleVoiceDraftSubmit();
                  }}
                  className="flex items-center gap-2 p-1.5 rounded-full bg-slate-900/90 border border-slate-800/80 shadow-lg"
                >
                  <input
                    type="text"
                    value={voiceInputDraft}
                    onChange={(e) => setVoiceInputDraft(e.target.value)}
                    placeholder="Or type here to speak in Voice Mode..."
                    className="flex-1 bg-transparent px-4 py-1.5 text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!voiceInputDraft.trim()}
                    className="p-2 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
                    title="Send and Speak"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* 5. SETTINGS MODAL */}
          {/* ========================================================================= */}
          {settingsOpen && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4">
              <div className="bg-[#121824] border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                  <div className="flex items-center gap-2">
                    <Settings className="w-4 h-4 text-cyan-400" />
                    <h3 className="font-semibold text-sm text-slate-100">NEXUS Settings</h3>
                  </div>
                  <button
                    onClick={() => setSettingsOpen(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-4 text-xs">
                  <div>
                    <label className="text-slate-400 font-medium block mb-1">Gateway Endpoint</label>
                    <input
                      type="text"
                      value={gatewayUrl}
                      onChange={(e) => setGatewayUrl(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>

                  <div>
                    <label className="text-slate-400 font-medium block mb-1">Active Model</label>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="nexus:latest">nexus:latest (Authoritative)</option>
                      <option value="nexus:0.8b">nexus:0.8b (LoRA Checkpoint)</option>
                      <option value="qwen3.5:0.8b">qwen3.5:0.8b (Base Model)</option>
                      <option value="qwen3.5:2b-q4_K_M">qwen3.5:2b-q4_K_M (Quantized 2B)</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between text-slate-400 font-medium mb-1">
                      <span>Temperature</span>
                      <span>{temperature}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                  </div>

                  <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 space-y-1.5 text-[11px] text-slate-400">
                    <div className="flex justify-between">
                      <span>Base Lineage:</span>
                      <span className="text-slate-200 font-mono">Qwen3.5 0.8B</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Inference Runtime:</span>
                      <span className="text-slate-200 font-mono">Ollama 0.40.6 (Port 11434)</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Acceleration:</span>
                      <span className="text-slate-200 font-mono">RTX 4050 6GB Laptop GPU</span>
                    </div>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => setSettingsOpen(false)}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium text-xs hover:opacity-95 transition-opacity"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
