// Chat : appels aux API Anthropic (Claude) et OpenAI (ChatGPT), exécutés dans
// le service worker — les host_permissions du manifest y suppriment le CORS et
// les clés API restent hors de la page. Le content script (chat.ts) ouvre un
// Port « excalihub-chat » et reçoit la réponse en continu (flux SSE).
// fetch direct plutôt que les SDK : leurs import() dynamiques sont interdits
// dans un service worker MV3.
import type { ChatPortRequest, ChatPortResponse, ChatProvider, ChatRequest } from "./chatShared";

const SYSTEM_PROMPT =
  "You are a helpful assistant in a side panel of the Excalidraw whiteboard. Answer concisely.";
const MAX_TOKENS = 16000;

// Fournisseurs parlant le protocole « chat/completions » d'OpenAI ;
// Claude (API Anthropic) est traité à part
const OPENAI_COMPAT: Partial<Record<ChatProvider, { name: string; endpoint: string }>> = {
  openai: { name: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions" },
  openrouter: { name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
};

class ChatError extends Error {}

// Lit un flux SSE et passe à onData le contenu de chaque ligne « data: … »
async function readSSE(body: ReadableStream<Uint8Array>, onData: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith("data:")) onData(line.slice(5).trim());
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function streamClaude(
  request: ChatRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<void> {
  // Repli serveur si un garde-fou décline la requête (pas disponible sur Haiku)
  const withFallback = !request.model.startsWith("claude-haiku");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": request.key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(withFallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: request.messages,
      stream: true,
      ...(withFallback ? { fallbacks: "default" } : {}),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) throw new ChatError("Invalid Claude API key.");
    let detail = `Claude error (HTTP ${res.status})`;
    try {
      detail = (await res.json())?.error?.message ?? detail;
    } catch {
      // Corps absent ou non JSON : on garde le statut HTTP
    }
    throw new ChatError(detail);
  }

  let stopReason: string | null = null;
  await readSSE(res.body, (payload) => {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // fragment incomplet : ignoré
    }
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      onText(event.delta.text);
    } else if (event?.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
    } else if (event?.type === "error") {
      throw new ChatError(event.error?.message ?? "Claude stream error");
    }
  });
  if (stopReason === "refusal") throw new ChatError("Claude declined to answer this request.");
}

// OpenAI, mais aussi OpenRouter, Groq… : même protocole « chat/completions »
// avec flux SSE, seuls l'endpoint et le nom changent
async function streamOpenAICompatible(
  providerName: string,
  endpoint: string,
  request: ChatRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...request.messages],
      stream: true,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) throw new ChatError(`Invalid ${providerName} API key.`);
    let detail = `${providerName} error (HTTP ${res.status})`;
    try {
      detail = (await res.json())?.error?.message ?? detail;
    } catch {
      // Corps absent ou non JSON : on garde le statut HTTP
    }
    throw new ChatError(detail);
  }

  await readSSE(res.body, (payload) => {
    if (payload === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // fragment incomplet : ignoré
    }
    // OpenRouter peut signaler une erreur en plein flux, après le HTTP 200
    if (event?.error) throw new ChatError(event.error.message ?? `${providerName} stream error`);
    const text = event?.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) onText(text);
  });
}

async function run(request: ChatRequest, signal: AbortSignal, port: chrome.runtime.Port): Promise<void> {
  // postMessage lève si le port est déjà fermé (onglet fermé, panneau rechargé)
  const post = (msg: ChatPortResponse) => {
    try {
      port.postMessage(msg);
    } catch {
      // Personne n'écoute plus : rien à faire
    }
  };
  try {
    if (!request.key) throw new ChatError("No API key configured. Add one in the chat settings.");
    const onText = (text: string) => {
      if (!signal.aborted) post({ type: "chunk", text });
    };
    const compat = OPENAI_COMPAT[request.provider];
    if (compat) await streamOpenAICompatible(compat.name, compat.endpoint, request, signal, onText);
    else await streamClaude(request, signal, onText);
    post({ type: "done" });
  } catch (err) {
    if (signal.aborted) {
      post({ type: "done", stopped: true }); // arrêt demandé : la réponse partielle est gardée
      return;
    }
    post({ type: "error", message: (err as Error)?.message ?? String(err) });
  }
}

export function initChat(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "excalihub-chat") return;
    let abort: AbortController | null = null;
    port.onMessage.addListener((msg: ChatPortRequest) => {
      if (msg?.type === "chat:stop") {
        abort?.abort();
        return;
      }
      if (msg?.type !== "chat:send" || !Array.isArray(msg.request?.messages)) return;
      abort?.abort();
      abort = new AbortController();
      void run(msg.request, abort.signal, port);
    });
    port.onDisconnect.addListener(() => abort?.abort());
  });
}
