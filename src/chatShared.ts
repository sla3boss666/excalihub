// Types du chat, partagés entre le content script (chat.ts) et le service
// worker (chatApi.ts). Types seulement, importés avec « import type » : aucun
// code partagé au runtime — Vite en ferait un chunk commun, et un import ESM
// casserait le content script, chargé en script classique par Chrome.

export type ChatProvider = "claude" | "openai" | "openrouter";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  image?: string; // capture d'une sélection du canevas (data URL PNG), jamais persistée
}

export interface ChatSettings {
  provider: ChatProvider;
  keys: Record<ChatProvider, string>;
  models: Record<ChatProvider, string>;
}

// Tout ce qu'il faut pour une requête : le service worker ne lit rien d'autre
export interface ChatRequest {
  provider: ChatProvider;
  model: string;
  key: string;
  messages: ChatMessage[];
}

// Messages échangés sur le Port « excalihub-chat »
export type ChatPortRequest =
  | { type: "chat:send"; request: ChatRequest }
  | { type: "chat:stop" };

export type ChatPortResponse =
  | { type: "chunk"; text: string }
  | { type: "done"; stopped?: boolean; truncated?: boolean }
  | { type: "error"; message: string };
