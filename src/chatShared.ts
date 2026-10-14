// Types du chat, partagés entre le content script (chat.ts) et le service
// worker (chatApi.ts). Types seulement, importés avec « import type » : aucun
// code partagé au runtime — Vite en ferait un chunk commun, et un import ESM
// casserait le content script, chargé en script classique par Chrome.

export type ChatProvider = "claude" | "openai" | "openrouter";

// Sélection du canevas jointe à une question
export interface ChatAttachment {
  label: string; // « 2 texts, 1 arrow » : affiché dans la bulle
  text: string; // description des éléments, envoyée au modèle
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  attachment?: ChatAttachment; // gardée dans l'historique (texte court)
  image?: string; // capture PNG de la sélection (data URL), jamais persistée
}

export interface ChatSettings {
  provider: ChatProvider;
  keys: Record<ChatProvider, string>;
  models: Record<ChatProvider, string>;
  float: boolean; // bulle de chat flottante sur le canevas
  boardContext: boolean; // décrire la page courante au modèle à chaque question
}

// Tout ce qu'il faut pour une requête : le service worker ne lit rien d'autre
export interface ChatRequest {
  provider: ChatProvider;
  model: string;
  key: string;
  messages: ChatMessage[];
  context?: string; // description de la page courante (ajoutée au prompt système)
}

// Messages échangés sur le Port « excalihub-chat »
export type ChatPortRequest =
  | { type: "chat:send"; request: ChatRequest }
  | { type: "chat:stop" };

export type ChatPortResponse =
  | { type: "chunk"; text: string }
  | { type: "done"; stopped?: boolean; truncated?: boolean }
  | { type: "error"; message: string };
