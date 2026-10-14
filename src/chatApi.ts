// Chat : appels aux API Anthropic (Claude) et OpenAI (ChatGPT), exécutés dans
// le service worker — les host_permissions du manifest y suppriment le CORS et
// les clés API restent hors de la page. Le content script (chat.ts) ouvre un
// Port « excalihub-chat » et reçoit la réponse en continu (flux SSE).
// fetch direct plutôt que les SDK : leurs import() dynamiques sont interdits
// dans un service worker MV3.
import type { ChatMessage, ChatPortRequest, ChatPortResponse, ChatProvider, ChatRequest } from "./chatShared";

// Le panneau rend le Markdown et le LaTeX (chatMarkdown.ts) : on le dit au
// modèle pour qu'il formate ses réponses en conséquence
const SYSTEM_PROMPT =
  "You are a helpful assistant in a side panel of the Excalidraw whiteboard. Answer concisely. " +
  "Format answers in Markdown (headings, lists, tables, fenced code blocks). " +
  "Write math in LaTeX: $…$ inline and $$…$$ on its own line for display equations. " +
  "Never wrap the whole answer in a code fence, and do not include hidden reasoning or <think> tags in the answer. " +
  "You may be given a description of the user's current board page, and messages may include the elements " +
  "the user had selected (as text, and as an image when available). Use them to answer questions about the drawing; " +
  "when the question is unrelated to the board, just answer it.";

// Prompt système du moment : consigne fixe + description de la page
function systemPrompt(request: ChatRequest): string {
  return request.context ? `${SYSTEM_PROMPT}\n\n${request.context}` : SYSTEM_PROMPT;
}

// Texte d'un message utilisateur, sélection jointe comprise
function userText(msg: ChatMessage): string {
  if (!msg.attachment) return msg.content;
  return `${msg.content}\n\n[Elements selected on the board when asking this]\n${msg.attachment.text}`;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

// Messages au format Anthropic : l'image (capture de la sélection) précède le texte
function claudeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") return { role: "assistant", content: msg.content };
    const image = msg.image ? parseDataUrl(msg.image) : null;
    if (!image) return { role: "user", content: userText(msg) };
    return {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: userText(msg) },
      ],
    };
  });
}

// Messages au format OpenAI (chat/completions)
function openAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") return { role: "assistant", content: msg.content };
    if (!msg.image) return { role: "user", content: userText(msg) };
    return {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: msg.image } },
        { type: "text", text: userText(msg) },
      ],
    };
  });
}
const MAX_TOKENS = 16000;

// Fournisseurs parlant le protocole « chat/completions » d'OpenAI ;
// Claude (API Anthropic) est traité à part
// `extra` : paramètres propres au fournisseur. OpenAI n'accepte plus
// max_tokens sur GPT-5 (max_completion_tokens) ; OpenRouter borne la réponse
// et freine la répétition (les modèles gratuits dégénèrent parfois en boucle)
const OPENAI_COMPAT: Partial<Record<ChatProvider, { name: string; endpoint: string; extra: Record<string, unknown> }>> = {
  openai: {
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    extra: { max_completion_tokens: MAX_TOKENS },
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    extra: { max_tokens: MAX_TOKENS, repetition_penalty: 1.05 },
  },
};

class ChatError extends Error {}

// Erreur d'un fournisseur refusant une image en entrée, par exemple
// « No endpoints found that support image input » (OpenRouter) ou
// « Invalid content type. image_url is only supported by certain models » (OpenAI)
function rejectsImages(err: unknown): boolean {
  if (!(err instanceof ChatError)) return false;
  return /image|vision|multimodal|modalit|content type|input type/i.test(err.message);
}

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
      system: systemPrompt(request),
      messages: claudeMessages(request.messages),
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
  extra: Record<string, unknown>,
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
      messages: [{ role: "system", content: systemPrompt(request) }, ...openAIMessages(request.messages)],
      stream: true,
      ...extra,
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
    let streamed = false;
    const onText = (text: string) => {
      streamed = true;
      if (!signal.aborted) post({ type: "chunk", text });
    };
    const stream = (req: ChatRequest) => {
      const compat = OPENAI_COMPAT[req.provider];
      return compat
        ? streamOpenAICompatible(compat.name, compat.endpoint, compat.extra, req, signal, onText)
        : streamClaude(req, signal, onText);
    };
    try {
      await stream(request);
    } catch (err) {
      // Modèle qui ne voit pas les images (surtout les modèles gratuits
      // d'OpenRouter) : on renvoie la même question sans les captures, la
      // sélection restant décrite en texte
      if (!rejectsImages(err) || streamed || signal.aborted || !request.messages.some((m) => m.image)) throw err;
      post({ type: "chunk", text: "*This model can't see images: answering from the text description of the selection.*\n\n" });
      await stream({ ...request, messages: request.messages.map(({ image: _image, ...m }) => m) });
    }
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
