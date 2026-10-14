// Onglet Chat : discussion avec Claude (Anthropic), ChatGPT (OpenAI) ou un
// modèle open source (OpenRouter). Les requêtes partent du service worker
// (voir chatApi.ts) ; ici : interface, historique local, réglages
// (fournisseur, modèle, clé API), rendu Markdown/LaTeX des réponses
// (chatMarkdown.ts) et mode flottant (fenêtre déplaçable sur le canevas).
import type { ChatAttachment, ChatMessage, ChatPortResponse, ChatProvider, ChatSettings } from "./chatShared";
import {
  captureSelection,
  describeBoard,
  describeSelection,
  kindsLabel,
  readBoard,
  readSelectionSummary,
  SelectionSummary,
} from "./chatContext";
import { findGibberish, hydrateMath, renderMarkdown, stripThinking } from "./chatMarkdown";
import { getExcalidrawTheme } from "./theme";

const HISTORY_KEY = "excalihub-chat-history";
const HISTORY_MAX = 60; // messages gardés (la conversation entière part à chaque requête)
const MAX_IMAGES_SENT = 3; // captures de sélection envoyées au plus par requête
const DEGENERATION_NOTE =
  "\n\n*The model's answer turned into gibberish and was cut off here. Ask again, or pick another model.*";
const FLOAT_KEY = "excalihub-chat-float"; // position, taille et état de la fenêtre flottante

// Tout ce qui distingue un fournisseur côté interface ; l'endpoint
// correspondant est dans chatApi.ts. `vision` : le modèle accepte une image
// (capture de la sélection) ; sinon seule sa description texte est envoyée.
interface ModelInfo {
  id: string;
  label: string;
  vision?: boolean;
}

const PROVIDERS: Record<ChatProvider, { label: string; models: ModelInfo[]; hint: string }> = {
  claude: {
    label: "Claude",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", vision: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", vision: true },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", vision: true },
    ],
    hint: "API key from console.anthropic.com (a claude.ai subscription alone has no API access).",
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    models: [
      { id: "gpt-5.1", label: "GPT-5.1", vision: true },
      { id: "gpt-5-mini", label: "GPT-5 mini", vision: true },
      { id: "gpt-4o", label: "GPT-4o", vision: true },
    ],
    hint: "API key from platform.openai.com (a ChatGPT Plus subscription alone has no API access).",
  },
  // Meilleurs modèles open source à endpoint gratuit (vérifié oct. 2026) ;
  // la liste « :free » d'OpenRouter tourne souvent — « Auto » prend ce qui est
  // en vie (et vise les modèles qui voient les images). L'image est envoyée
  // à tous ; un modèle texte seul la refuse et chatApi.ts réessaie sans.
  openrouter: {
    label: "Open source (OpenRouter)",
    models: [
      { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B — sees images", vision: true },
      { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni — sees images", vision: true },
      { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B — sees images", vision: true },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B — best, text only" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B — text only" },
      { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning — fast, text only" },
      { id: "openrouter/free", label: "Auto (any free model)", vision: true },
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
  float: false,
  boardContext: true,
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
    float: stored.float === true,
    boardContext: stored.boardContext !== false,
  };
}

function currentModel(): ModelInfo | undefined {
  return PROVIDERS[settings.provider].models.find((m) => m.id === settings.models[settings.provider]);
}

function saveSettings(): void {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
}

const providerOptions = (Object.keys(PROVIDERS) as ChatProvider[])
  .map((p) => `<option value="${p}">${PROVIDERS[p].label}</option>`)
  .join("");

// Icônes Tabler au trait fin (comme l'en-tête du panneau)
const icon = (paths: string) =>
  `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICON_FLOAT = icon(`<path d="M4 4h12v7"/><path d="M4 4v16h16v-8"/><path d="M20 4l-9 9"/><path d="M14 4h6v6"/>`);
const ICON_DOCK = icon(`<path d="M20 20h-12v-7"/><path d="M20 20v-16h-16v8"/><path d="M4 20l9 -9"/><path d="M10 20h-6v-6"/>`);
const ICON_MINIMIZE = icon(`<path d="M5 12h14"/>`);
const ICON_CHAT = icon(
  `<path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/>`,
);

// Interface du chat : déplacée telle quelle entre l'onglet du panneau
// (#excalihub-chat-slot) et la fenêtre flottante
const CHAT_HTML = `
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
      <button type="button" class="excalihub-chat-iconbtn" id="excalihub-chat-float-btn"
        title="Float over the board" aria-label="Float over the board">${ICON_FLOAT}</button>
    </div>
    <div class="excalihub-chat-key-row">
      <input type="password" id="excalihub-chat-key" placeholder="API key" autocomplete="off" spellcheck="false" />
      <button type="button" class="excalihub-btn" id="excalihub-chat-key-save">Save</button>
    </div>
    <p class="excalihub-chat-key-hint" id="excalihub-chat-key-hint"></p>
  </div>
  <div class="excalihub-chat-messages" id="excalihub-chat-messages"></div>
  <div class="excalihub-pres-footer excalihub-chat-footer">
    <div class="excalihub-chat-context">
      <label class="excalihub-chat-ctx-toggle" title="Describe the current page to the assistant with every message">
        <input type="checkbox" id="excalihub-chat-ctx-board" /><span>Board context</span>
      </label>
      <span class="excalihub-chat-ctx-selection" id="excalihub-chat-ctx-selection" hidden
        title="The selected elements will be attached to your next message">
        <span id="excalihub-chat-ctx-selection-label"></span>
        <button type="button" class="excalihub-chat-ctx-dismiss" id="excalihub-chat-ctx-dismiss"
          title="Don't attach the selection" aria-label="Don't attach the selection">×</button>
      </span>
    </div>
    <textarea id="excalihub-chat-input" rows="3"
      placeholder="Message… (Enter to send, Shift+Enter: new line)"></textarea>
    <div class="excalihub-chat-actions">
      <button type="button" class="excalihub-btn" id="excalihub-chat-clear">Clear</button>
      <button type="button" class="excalihub-btn primary" id="excalihub-chat-send">Send</button>
    </div>
  </div>
`;

// Fenêtre flottante (en-tête déplaçable, coin redimensionnable) et bulle
// d'ouverture, toutes deux hors du panneau, directement dans le body
const FLOAT_HTML = `
  <div class="excalihub-chat-float-header" id="excalihub-chat-float-header">
    <span class="excalihub-chat-float-title">${ICON_CHAT}<span>Chat</span></span>
    <button type="button" class="excalihub-chat-iconbtn" id="excalihub-chat-dock"
      title="Back to the panel" aria-label="Back to the panel">${ICON_DOCK}</button>
    <button type="button" class="excalihub-chat-iconbtn" id="excalihub-chat-float-close"
      title="Minimize" aria-label="Minimize">${ICON_MINIMIZE}</button>
  </div>
  <div class="excalihub-chat-float-body" id="excalihub-chat-float-body"></div>
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
    // Sans les captures (lourdes, et la page pourrait les lire) : le texte
    // de la sélection suffit pour la suite de la conversation
    const slim = history.slice(-HISTORY_MAX).map(({ image: _image, ...msg }) => msg);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
  } catch {
    // Stockage indisponible : l'historique vaut pour cette session seulement
  }
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function messagesBox(): HTMLElement {
  return el("excalihub-chat-messages");
}

// Défilement automatique seulement si l'utilisateur est déjà en bas (sinon
// il est en train de relire plus haut : on ne le dérange pas)
function nearBottom(box: HTMLElement): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}

// Réponses de l'assistant : Markdown (titres, listes, tableaux, code…) et
// formules LaTeX rendues. Les messages de l'utilisateur restent en texte brut.
function renderAssistant(bubble: HTMLElement, content: string): void {
  const { html, math } = renderMarkdown(content);
  bubble.innerHTML = html;
  if (math.length) void hydrateMath(bubble);
}

// Message de l'utilisateur : la sélection jointe (vignette et résumé) au-dessus du texte
function renderUser(bubble: HTMLElement, msg: ChatMessage): void {
  bubble.textContent = "";
  if (msg.attachment) {
    const attach = document.createElement("div");
    attach.className = "excalihub-chat-attach";
    if (msg.image) {
      const img = document.createElement("img");
      img.src = msg.image;
      img.alt = "Selected elements";
      attach.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = `Selection: ${msg.attachment.label}`;
    attach.appendChild(label);
    bubble.appendChild(attach);
  }
  bubble.appendChild(document.createTextNode(msg.content));
}

function appendBubble(role: "user" | "assistant", content: string, msg?: ChatMessage): HTMLElement {
  const box = messagesBox();
  box.querySelector(".excalihub-chat-empty")?.remove();
  const bubble = document.createElement("div");
  bubble.className = `excalihub-chat-msg ${role}`;
  if (role === "assistant" && content) renderAssistant(bubble, content);
  else if (role === "user" && msg) renderUser(bubble, msg);
  else bubble.textContent = content;
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
  for (const msg of history) appendBubble(msg.role, msg.content, msg);
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
    renderSelectionChip(); // mention « text only » selon le modèle
  });
  modelSelect.addEventListener("change", () => {
    settings.models[settings.provider] = modelSelect.value;
    saveSettings();
    renderSelectionChip();
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

// ── Mode flottant ────────────────────────────────────────────────────
interface FloatState {
  left: number;
  top: number;
  width: number;
  height: number;
  open: boolean;
}

const FLOAT_DEFAULT_SIZE = { width: 400, height: 540 };
const FLOAT_MIN = { width: 300, height: 320 };

function loadFloatState(): FloatState {
  const fallback: FloatState = {
    ...FLOAT_DEFAULT_SIZE,
    left: window.innerWidth - FLOAT_DEFAULT_SIZE.width - 16,
    top: window.innerHeight - FLOAT_DEFAULT_SIZE.height - 80,
    open: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(FLOAT_KEY) ?? "null") as Partial<FloatState> | null;
    if (saved && typeof saved === "object") {
      const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
      return {
        left: num(saved.left, fallback.left),
        top: num(saved.top, fallback.top),
        width: num(saved.width, fallback.width),
        height: num(saved.height, fallback.height),
        open: saved.open !== false,
      };
    }
  } catch {
    // État absent ou illisible : valeurs par défaut
  }
  return fallback;
}

let floatState: FloatState;

function saveFloatState(): void {
  try {
    localStorage.setItem(FLOAT_KEY, JSON.stringify(floatState));
  } catch {
    // Stockage indisponible : la position vaut pour cette session seulement
  }
}

// Garde la fenêtre dans la zone visible (écran redimensionné, autre résolution…)
function clampFloat(): void {
  const win = el("excalihub-chat-float");
  const maxW = Math.max(FLOAT_MIN.width, window.innerWidth - 16);
  const maxH = Math.max(FLOAT_MIN.height, window.innerHeight - 16);
  floatState.width = Math.min(Math.max(floatState.width, FLOAT_MIN.width), maxW);
  floatState.height = Math.min(Math.max(floatState.height, FLOAT_MIN.height), maxH);
  floatState.left = Math.min(Math.max(floatState.left, 0), Math.max(0, window.innerWidth - floatState.width));
  floatState.top = Math.min(Math.max(floatState.top, 0), Math.max(0, window.innerHeight - floatState.height));
  win.style.left = `${floatState.left}px`;
  win.style.top = `${floatState.top}px`;
  win.style.width = `${floatState.width}px`;
  win.style.height = `${floatState.height}px`;
}

// Thème initial ; ensuite content.ts (applyTheme) suit les changements
function applyChatTheme(): void {
  const isDark = getExcalidrawTheme() === "dark";
  el("excalihub-chat-float")?.classList.toggle("theme-dark", isDark);
  el("excalihub-chat-bubble")?.classList.toggle("theme-dark", isDark);
}

function createFloatUI(): void {
  const win = document.createElement("div");
  win.id = "excalihub-chat-float";
  win.hidden = true;
  win.innerHTML = FLOAT_HTML;
  document.body.appendChild(win);

  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.id = "excalihub-chat-bubble";
  bubble.title = "Chat";
  bubble.setAttribute("aria-label", "Chat");
  bubble.innerHTML = ICON_CHAT;
  bubble.hidden = true;
  document.body.appendChild(bubble);

  floatState = loadFloatState();
  applyChatTheme();

  bubble.addEventListener("click", () => setFloatOpen(win.hidden));
  el("excalihub-chat-float-close").addEventListener("click", () => setFloatOpen(false));
  el("excalihub-chat-dock").addEventListener("click", () => setFloat(false));
  el("excalihub-chat-float-btn").addEventListener("click", () => setFloat(true));
  el("excalihub-chat-dock-back").addEventListener("click", () => setFloat(false));

  // Échap dans la fenêtre flottante : on la replie (la bulle reste)
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setFloatOpen(false);
    }
  });

  // Déplacement par l'en-tête (sauf sur ses boutons)
  const header = el("excalihub-chat-float-header");
  let drag: { dx: number; dy: number } | null = null;
  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    drag = { dx: e.clientX - floatState.left, dy: e.clientY - floatState.top };
    header.setPointerCapture(e.pointerId);
    win.classList.add("dragging");
    e.preventDefault();
  });
  header.addEventListener("pointermove", (e) => {
    if (!drag) return;
    floatState.left = e.clientX - drag.dx;
    floatState.top = e.clientY - drag.dy;
    clampFloat();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    win.classList.remove("dragging");
    saveFloatState();
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);

  // Redimensionnement par le coin (CSS resize) : on mémorise la taille
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  new ResizeObserver(() => {
    if (win.hidden || drag) return;
    const { width, height } = win.getBoundingClientRect();
    if (!width || !height) return;
    if (Math.abs(width - floatState.width) < 1 && Math.abs(height - floatState.height) < 1) return;
    floatState.width = width;
    floatState.height = height;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      clampFloat();
      saveFloatState();
    }, 150);
  }).observe(win);

  window.addEventListener("resize", () => {
    if (!win.hidden) clampFloat();
  });
}

// `focus` : faux au chargement de la page, pour ne pas voler le focus au canevas
function setFloatOpen(open: boolean, focus = true): void {
  const win = el("excalihub-chat-float");
  floatState.open = open;
  win.hidden = !open;
  el("excalihub-chat-bubble").classList.toggle("active", open);
  if (open) {
    clampFloat();
    const box = messagesBox();
    box.scrollTop = box.scrollHeight;
    if (focus) focusChatInput();
  }
  saveFloatState();
}

// Place l'interface du chat dans le panneau ou dans la fenêtre flottante
function placeChat(): void {
  const root = el("excalihub-chat-root");
  const note = el("excalihub-chat-dock-note");
  const bubble = el("excalihub-chat-bubble");
  if (settings.float) {
    el("excalihub-chat-float-body").appendChild(root);
    note.hidden = false;
    bubble.hidden = false;
    setFloatOpen(floatState.open, false);
  } else {
    el("excalihub-chat-float").hidden = true;
    bubble.hidden = true;
    note.hidden = true;
    el("excalihub-chat-slot").appendChild(root);
  }
  el("excalihub-chat-float-btn").hidden = settings.float;
}

function setFloat(on: boolean): void {
  if (settings.float === on) {
    if (on) setFloatOpen(true);
    return;
  }
  settings.float = on;
  saveSettings();
  if (on) floatState.open = true;
  placeChat();
  focusChatInput();
}

// Appelé par content.ts quand l'onglet Chat du panneau est affiché : en
// mode flottant, la fenêtre s'ouvre (le panneau ne montre qu'une note)
export function showChatInPanel(): void {
  if (!settings) return; // réglages pas encore chargés (initChatTab en cours)
  if (settings.float) setFloatOpen(true);
  else placeChat();
}

// ── Sélection du canevas ─────────────────────────────────────────────
// Interrogée régulièrement tant que le chat est visible ; un chip au-dessus
// de la saisie annonce ce qui sera joint au prochain message. L'utilisateur
// peut l'écarter (jusqu'à ce que la sélection change) ; après l'envoi, la
// même sélection n'est pas rejointe (elle est déjà dans la conversation).
const SELECTION_POLL_MS = 700;
let selection: SelectionSummary | null = null;
let dismissedSignature = "";

function chatVisible(): boolean {
  const root = el("excalihub-chat-root");
  if (!root) return false;
  const check = (root as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return check ? check.call(root, { visibilityProperty: true }) : root.getClientRects().length > 0;
}

function attachedSelection(): SelectionSummary | null {
  return selection && selection.count > 0 && selection.signature !== dismissedSignature ? selection : null;
}

function renderSelectionChip(): void {
  const chip = el("excalihub-chat-ctx-selection");
  const current = attachedSelection();
  chip.hidden = !current;
  if (!current) return;
  const model = currentModel();
  const textOnly = model !== undefined && !model.vision;
  el("excalihub-chat-ctx-selection-label").textContent =
    `Selection: ${kindsLabel(current.kinds)}${textOnly ? " (text only)" : ""}`;
  chip.title = textOnly
    ? "This model doesn't see images: the selection is described in text. Pick a model marked « sees images » to send the picture."
    : "The selected elements (text and picture) will be attached to your next message";
}

async function pollSelection(): Promise<void> {
  if (!chatVisible()) return;
  const summary = await readSelectionSummary().catch(() => null);
  if (!summary || summary.signature === selection?.signature) return;
  selection = summary;
  renderSelectionChip();
}

function dismissSelection(): void {
  dismissedSignature = selection?.signature ?? "";
  renderSelectionChip();
}

// Contexte joint à la question : description de la page (si activée) et
// sélection (texte, plus capture PNG pour les modèles qui voient les images)
async function gatherContext(): Promise<{ context?: string; attachment?: ChatAttachment; image?: string }> {
  const current = attachedSelection();
  if (!settings.boardContext && !current) return {};
  try {
    const board = await readBoard();
    const out: { context?: string; attachment?: ChatAttachment; image?: string } = {};
    if (settings.boardContext) out.context = describeBoard(board);
    if (current) {
      const described = describeSelection(board);
      if (described) {
        out.attachment = described;
        // Capture envoyée quel que soit le modèle : s'il ne voit pas les
        // images, le service worker réessaie sans (voir chatApi.ts)
        out.image = (await captureSelection()) ?? undefined;
      }
    }
    return out;
  } catch {
    return {}; // bridge indisponible : la question part sans contexte
  }
}

// ── Envoi et réception ───────────────────────────────────────────────
function setStreaming(on: boolean): void {
  streaming = on;
  const sendBtn = el<HTMLButtonElement>("excalihub-chat-send");
  sendBtn.textContent = on ? "Stop" : "Send";
  sendBtn.classList.toggle("primary", !on);
  sendBtn.classList.toggle("danger", on);
}

function finishStream(bubble: HTMLElement, raw: string): void {
  bubble.classList.remove("streaming");
  // Raisonnement éventuel (<think>) retiré de ce qui est gardé et renvoyé au modèle
  const text = stripThinking(raw).text || raw.trim();
  // bulle plus affichée = conversation effacée pendant la réponse : on la jette
  if (text && bubble.isConnected) {
    renderAssistant(bubble, text);
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

let preparing = false; // contexte en cours de lecture (avant l'envoi)

async function send(): Promise<void> {
  const input = el<HTMLTextAreaElement>("excalihub-chat-input");
  const text = input.value.trim();
  if (!text || streaming || preparing) return;
  if (!currentKey()) {
    el<HTMLInputElement>("excalihub-chat-key").focus();
    return;
  }

  const sendBtn = el<HTMLButtonElement>("excalihub-chat-send");
  preparing = true;
  sendBtn.disabled = true;
  let gathered: Awaited<ReturnType<typeof gatherContext>>;
  try {
    gathered = await gatherContext();
  } finally {
    preparing = false;
    sendBtn.disabled = false;
  }
  if (attachedSelection()) dismissSelection(); // jointe : pas de nouveau au message suivant

  const message: ChatMessage = { role: "user", content: text, attachment: gathered.attachment, image: gathered.image };
  history.push(message);
  saveHistory();
  input.value = "";
  appendBubble("user", text, message);
  const bubble = appendBubble("assistant", "");
  bubble.classList.add("streaming");
  setStreaming(true);

  // Pendant la réponse : le Markdown est re-rendu à chaque image (bon
  // marché), les formules au plus toutes les 600 ms (MathJax coûte plus).
  // Si la réponse dégénère en charabia (modèles gratuits), on coupe et on
  // arrête le flux ; ce qui précède est gardé.
  let answer = "";
  let frame = 0;
  let lastMath = 0;
  let degenerated = false;
  const paint = () => {
    frame = 0;
    const box = messagesBox();
    const follow = nearBottom(box);
    if (!degenerated) {
      const cut = findGibberish(answer);
      if (cut >= 0) {
        degenerated = true;
        answer = `${answer.slice(0, cut).trimEnd()}${DEGENERATION_NOTE}`;
        stop();
      }
    }
    const { html, math } = renderMarkdown(answer);
    bubble.innerHTML = html;
    if (math.length && Date.now() - lastMath > 600) {
      lastMath = Date.now();
      void hydrateMath(bubble);
    }
    if (follow) box.scrollTop = box.scrollHeight;
  };

  port = chrome.runtime.connect({ name: "excalihub-chat" });
  port.onMessage.addListener((msg: ChatPortResponse) => {
    if (msg.type === "chunk") {
      if (degenerated) return; // morceaux encore en route après l'arrêt
      answer += msg.text;
      frame ||= requestAnimationFrame(paint);
    } else if (msg.type === "done") {
      if (frame) cancelAnimationFrame(frame);
      finishStream(bubble, answer);
    } else if (msg.type === "error") {
      if (frame) cancelAnimationFrame(frame);
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
    if (streaming) {
      if (frame) cancelAnimationFrame(frame);
      finishStream(bubble, answer);
    }
  });

  // L'API Anthropic exige que la conversation commence par un message « user »
  const messages = history.slice(-HISTORY_MAX).map((m) => ({ ...m }));
  while (messages[0]?.role === "assistant") messages.shift();
  // Captures : seulement les plus récentes (coût en jetons et en octets)
  let imagesLeft = MAX_IMAGES_SENT;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].image) continue;
    if (imagesLeft > 0) imagesLeft--;
    else delete messages[i].image;
  }

  port.postMessage({
    type: "chat:send",
    request: {
      provider: settings.provider,
      model: settings.models[settings.provider],
      key: currentKey(),
      messages,
      context: gathered.context,
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
  // Interface dans l'onglet du panneau ; à côté, la note affichée quand le
  // chat est parti flotter sur le canevas
  const slot = el("excalihub-chat-slot");
  const root = document.createElement("div");
  root.id = "excalihub-chat-root";
  root.innerHTML = CHAT_HTML;
  slot.appendChild(root);
  const note = document.createElement("div");
  note.id = "excalihub-chat-dock-note";
  note.className = "excalihub-chat-dock-note";
  note.hidden = true;
  note.innerHTML = `
    <p>The chat is floating over the board.</p>
    <button type="button" class="excalihub-btn" id="excalihub-chat-dock-back">${ICON_DOCK}<span>Back to the panel</span></button>
  `;
  slot.appendChild(note);

  settings = await loadChatSettings();
  history = loadHistory();
  initSettingsUI();
  refreshSettingsUI();
  renderMessages();
  createFloatUI();
  placeChat();

  const input = el<HTMLTextAreaElement>("excalihub-chat-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  el("excalihub-chat-send").addEventListener("click", () => (streaming ? stop() : void send()));
  el("excalihub-chat-clear").addEventListener("click", () => {
    if (streaming) stop();
    history = [];
    saveHistory();
    renderMessages();
  });

  // Contexte du dessin : case « page » et chip de sélection
  const boardToggle = el<HTMLInputElement>("excalihub-chat-ctx-board");
  boardToggle.checked = settings.boardContext;
  boardToggle.addEventListener("change", () => {
    settings.boardContext = boardToggle.checked;
    saveSettings();
  });
  el("excalihub-chat-ctx-dismiss").addEventListener("click", dismissSelection);
  setInterval(() => void pollSelection(), SELECTION_POLL_MS);
}
