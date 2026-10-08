// Onglet Chat : discussion avec Claude (Anthropic) ou ChatGPT (OpenAI).
// Les requêtes partent du service worker (voir chatApi.ts) ; ici : interface,
// historique local et réglages (fournisseur, modèle, clé API).
import type { ChatMessage, ChatPortResponse, ChatProvider, ChatSettings } from "./chatShared";

const HISTORY_KEY = "excalihub-chat-history";
const HISTORY_MAX = 60; // messages gardés (la conversation entière part à chaque requête)

// Tout ce qui distingue un fournisseur côté interface ; l'endpoint
// correspondant est dans chatApi.ts
const PROVIDERS: Record<ChatProvider, { label: string; models: { id: string; label: string }[]; hint: string }> = {
  claude: {
    label: "Claude",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ],
    hint: "API key from console.anthropic.com (a claude.ai subscription alone has no API access).",
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    models: [
      { id: "gpt-5.1", label: "GPT-5.1" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
      { id: "gpt-4o", label: "GPT-4o" },
    ],
    hint: "API key from platform.openai.com (a ChatGPT Plus subscription alone has no API access).",
  },
  // Meilleurs modèles open source à endpoint gratuit (vérifié oct. 2026) ;
  // la liste « :free » d'OpenRouter tourne souvent — « Auto » prend ce qui est en vie
  openrouter: {
    label: "Open source (OpenRouter)",
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B — best" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B" },
      { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning — fast" },
      { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B" },
      { id: "openrouter/free", label: "Auto (any free model)" },
    ],
    hint: "Free API key from openrouter.ai/keys — no card needed (free tier: 20 requests/min, 50/day). Free models may use your prompts for training.",
  },
};

// Clés API et réglages dans chrome.storage.local : inaccessibles à la page
// excalidraw.com (contrairement au localStorage, qui ne garde que l'historique)
const SETTINGS_KEY = "excalihub-chat-settings";

const SETTINGS_DEFAULTS: ChatSettings = {
  provider: "claude",
  keys: { claude: "", openai: "", openrouter: "" },
  models: {
    claude: "claude-opus-5-5",
    openai: "gpt-5.1",
    openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  },
};

async function loadChatSettings(): Promise<ChatSettings> {
  const stored = ((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {}) as Partial<ChatSettings>;
  // Premier format (une paire de champs claudeKey/openaiKey…) : on migre
  const old = stored as { claudeKey?: string; openaiKey?: string; claudeModel?: string; openaiModel?: string };
  return {
    provider: stored.provider && stored.provider in PROVIDERS ? stored.provider : SETTINGS_DEFAULTS.provider,
    keys: {
      ...SETTINGS_DEFAULTS.keys,
      ...(old.claudeKey && { claude: old.claudeKey }),
      ...(old.openaiKey && { openai: old.openaiKey }),
      ...(stored.keys ?? {}),
    },
    models: {
      ...SETTINGS_DEFAULTS.models,
      ...(old.claudeModel && { claude: old.claudeModel }),
      ...(old.openaiModel && { openai: old.openaiModel }),
      ...(stored.models ?? {}),
    },
  };
}

function saveSettings(): void {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
}

const providerOptions = (Object.keys(PROVIDERS) as ChatProvider[])
  .map((p) => `<option value="${p}">${PROVIDERS[p].label}</option>`)
  .join("");

export const CHAT_TAB_HTML = `
  <div class="excalihub-chat-settings">
    <div class="excalihub-chat-settings-row">
      <label class="excalihub-pres-setting">
        <span>Assistant</span>
        <select id="excalihub-chat-provider">${providerOptions}</select>
      </label>
      <label class="excalihub-pres-setting">
        <span>Model</span>
        <select id="excalihub-chat-model"></select>
      </label>
    </div>
    <div class="excalihub-chat-key-row">
      <input type="password" id="excalihub-chat-key" placeholder="API key" autocomplete="off" spellcheck="false" />
      <button type="button" class="excalihub-btn" id="excalihub-chat-key-save">Save</button>
    </div>
    <p class="excalihub-chat-key-hint" id="excalihub-chat-key-hint"></p>
  </div>
  <div class="excalihub-chat-messages" id="excalihub-chat-messages"></div>
  <div class="excalihub-pres-footer excalihub-chat-footer">
    <textarea id="excalihub-chat-input" rows="3"
      placeholder="Message… (Enter to send, Shift+Enter: new line)"></textarea>
    <div class="excalihub-chat-actions">
      <button type="button" class="excalihub-btn" id="excalihub-chat-clear">Clear</button>
      <button type="button" class="excalihub-btn primary" id="excalihub-chat-send">Send</button>
    </div>
  </div>
`;

let settings: ChatSettings;
let history: ChatMessage[] = [];
let port: chrome.runtime.Port | null = null;
let streaming = false;

function loadHistory(): ChatMessage[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null");
    if (Array.isArray(saved)) return saved.filter((m) => m?.content && (m.role === "user" || m.role === "assistant"));
  } catch {
    // Historique absent ou illisible : on repart de zéro
  }
  return [];
}

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch {
    // Stockage indisponible : l'historique vaut pour cette session seulement
  }
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function messagesBox(): HTMLElement {
  return el("excalihub-chat-messages");
}

function appendBubble(role: "user" | "assistant", content: string): HTMLElement {
  const box = messagesBox();
  box.querySelector(".excalihub-chat-empty")?.remove();
  const bubble = document.createElement("div");
  bubble.className = `excalihub-chat-msg ${role}`;
  bubble.textContent = content;
  box.appendChild(bubble);
  box.scrollTop = box.scrollHeight;
  return bubble;
}

function renderMessages(): void {
  const box = messagesBox();
  box.innerHTML = "";
  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "excalihub-chat-empty";
    empty.textContent = "Ask Claude, ChatGPT or a free open-source model — without leaving the board.";
    box.appendChild(empty);
    return;
  }
  for (const msg of history) appendBubble(msg.role, msg.content);
}

// ── Réglages (fournisseur, modèle, clé) ─────────────────────────────
function currentKey(): string {
  return settings.keys[settings.provider] ?? "";
}

function refreshSettingsUI(): void {
  const providerSelect = el<HTMLSelectElement>("excalihub-chat-provider");
  const modelSelect = el<HTMLSelectElement>("excalihub-chat-model");
  providerSelect.value = settings.provider;

  const provider = PROVIDERS[settings.provider];
  modelSelect.innerHTML = provider.models
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join("");
  const selected = settings.models[settings.provider];
  if (provider.models.some((m) => m.id === selected)) modelSelect.value = selected;

  // La clé n'est jamais réécrite dans le DOM (la page pourrait la lire) :
  // le placeholder indique seulement qu'une clé est enregistrée.
  const keyInput = el<HTMLInputElement>("excalihub-chat-key");
  keyInput.value = "";
  keyInput.placeholder = currentKey() ? "API key saved — paste a new one to replace it" : "API key";
  el("excalihub-chat-key-hint").textContent = provider.hint;
}

function initSettingsUI(): void {
  const providerSelect = el<HTMLSelectElement>("excalihub-chat-provider");
  const modelSelect = el<HTMLSelectElement>("excalihub-chat-model");
  const keyInput = el<HTMLInputElement>("excalihub-chat-key");

  providerSelect.addEventListener("change", () => {
    settings.provider = providerSelect.value as ChatProvider;
    saveSettings();
    refreshSettingsUI();
  });
  modelSelect.addEventListener("change", () => {
    settings.models[settings.provider] = modelSelect.value;
    saveSettings();
  });

  const saveKey = () => {
    const key = keyInput.value.trim();
    if (!key) return;
    settings.keys[settings.provider] = key;
    saveSettings();
    refreshSettingsUI();
  };
  el("excalihub-chat-key-save").addEventListener("click", saveKey);
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
}

// ── Envoi et réception ───────────────────────────────────────────────
function setStreaming(on: boolean): void {
  streaming = on;
  const sendBtn = el<HTMLButtonElement>("excalihub-chat-send");
  sendBtn.textContent = on ? "Stop" : "Send";
  sendBtn.classList.toggle("primary", !on);
  sendBtn.classList.toggle("danger", on);
}

function finishStream(bubble: HTMLElement, text: string): void {
  bubble.classList.remove("streaming");
  // bulle plus affichée = conversation effacée pendant la réponse : on la jette
  if (text && bubble.isConnected) {
    history.push({ role: "assistant", content: text });
    saveHistory();
  } else {
    bubble.remove();
    if (history.length === 0) renderMessages();
  }
  port?.disconnect();
  port = null;
  setStreaming(false);
}

function send(): void {
  const input = el<HTMLTextAreaElement>("excalihub-chat-input");
  const text = input.value.trim();
  if (!text || streaming) return;
  if (!currentKey()) {
    el<HTMLInputElement>("excalihub-chat-key").focus();
    return;
  }

  history.push({ role: "user", content: text });
  saveHistory();
  input.value = "";
  appendBubble("user", text);
  const bubble = appendBubble("assistant", "");
  bubble.classList.add("streaming");
  setStreaming(true);

  let answer = "";
  port = chrome.runtime.connect({ name: "excalihub-chat" });
  port.onMessage.addListener((msg: ChatPortResponse) => {
    if (msg.type === "chunk") {
      answer += msg.text;
      bubble.textContent = answer;
      const box = messagesBox();
      box.scrollTop = box.scrollHeight;
    } else if (msg.type === "done") {
      finishStream(bubble, answer);
    } else if (msg.type === "error") {
      bubble.classList.add("error");
      bubble.textContent = msg.message;
      bubble.classList.remove("streaming");
      port?.disconnect();
      port = null;
      setStreaming(false);
    }
  });
  port.onDisconnect.addListener(() => {
    // Service worker arrêté ou extension rechargée en cours de réponse
    if (streaming) finishStream(bubble, answer);
  });

  // L'API Anthropic exige que la conversation commence par un message « user »
  const messages = history.slice(-HISTORY_MAX);
  while (messages[0]?.role === "assistant") messages.shift();

  port.postMessage({
    type: "chat:send",
    request: {
      provider: settings.provider,
      model: settings.models[settings.provider],
      key: currentKey(),
      messages,
    },
  });
}

function stop(): void {
  port?.postMessage({ type: "chat:stop" });
}

export function focusChatInput(): void {
  el<HTMLTextAreaElement>("excalihub-chat-input")?.focus();
}

export async function initChatTab(): Promise<void> {
  settings = await loadChatSettings();
  history = loadHistory();
  initSettingsUI();
  refreshSettingsUI();
  renderMessages();

  const input = el<HTMLTextAreaElement>("excalihub-chat-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  el("excalihub-chat-send").addEventListener("click", () => (streaming ? stop() : send()));
  el("excalihub-chat-clear").addEventListener("click", () => {
    if (streaming) stop();
    history = [];
    saveHistory();
    renderMessages();
  });
}
