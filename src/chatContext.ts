// Contexte du dessin pour le chat : description textuelle de la page et de
// la sélection (lues via le bridge, voir liteElements dans bridge.ts) et
// capture PNG de la sélection pour les modèles qui voient les images.
import { callBridge, callBridgeWithTimeout } from "./bridgeClient";
import { getPagesIndex } from "./pages";
import { toXml } from "./pdf";

export interface LiteElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string; // élément texte
  latex?: string; // formule (image générée par latex.ts)
  name?: string; // frame
  frameId?: string;
  containerId?: string; // texte lié à une forme
  link?: string;
  from?: string; // flèche : élément de départ
  to?: string; // flèche : élément d'arrivée
  stroke?: string;
  fill?: string;
}

export interface BoardSnapshot {
  pageName: string;
  elements: LiteElement[];
  selectedIds: string[];
}

export interface SelectionSummary {
  count: number;
  kinds: Record<string, number>;
  signature: string;
}

const MAX_CONTEXT_CHARS = 8000; // description de la page entière
const MAX_SELECTION_CHARS = 6000;
const MAX_TEXT_CHARS = 400; // par élément

export async function readBoard(): Promise<BoardSnapshot> {
  const [lite, index] = await Promise.all([
    callBridge<{ elements: LiteElement[]; selectedIds: string[] }>("getElementsLite"),
    getPagesIndex().catch(() => null),
  ]);
  const pageName = index?.pages.find((p) => p.id === index.currentId)?.name ?? "";
  return { pageName, elements: lite.elements, selectedIds: lite.selectedIds };
}

export function readSelectionSummary(): Promise<SelectionSummary> {
  return callBridge<SelectionSummary>("getSelectionSummary");
}

// ── Description en texte ────────────────────────────────────────────
const isFrame = (el: LiteElement) => el.type === "frame" || el.type === "magicframe";

const KIND_NAMES: Record<string, string> = {
  text: "text",
  rectangle: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
  arrow: "arrow",
  line: "line",
  freedraw: "freehand drawing",
  image: "image",
  frame: "frame",
  magicframe: "frame",
  formula: "formula",
  embeddable: "embed",
  iframe: "embed",
};

function kindOf(el: LiteElement): string {
  if (el.latex !== undefined) return "formula";
  return el.type;
}

function plural(kind: string, n: number): string {
  const name = KIND_NAMES[kind] ?? kind;
  return n === 1 ? name : `${name}s`;
}

// « 2 texts, 1 arrow » (ordre : les plus nombreux d'abord)
export function kindsLabel(kinds: Record<string, number>): string {
  return Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${plural(kind, n)}`)
    .join(", ");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS)}…` : flat;
}

// Texte porté par un élément : le sien, ou celui qui lui est lié (forme, flèche)
function labelOf(el: LiteElement, byId: Map<string, LiteElement>, boundText: Map<string, LiteElement>): string {
  if (el.text !== undefined) return el.text;
  if (el.latex !== undefined) return `$${el.latex}$`;
  if (isFrame(el)) return el.name ?? "";
  const bound = boundText.get(el.id);
  return bound?.text ?? "";
}

// Lignes décrivant `subset` (sous-ensemble de `all`), regroupées par frame.
// Les éléments sans texte sont seulement comptés.
function describeElements(subset: LiteElement[], all: LiteElement[]): string[] {
  const byId = new Map(all.map((el) => [el.id, el]));
  const boundText = new Map<string, LiteElement>();
  for (const el of all) if (el.containerId && el.text !== undefined) boundText.set(el.containerId, el);

  const inSubset = new Set(subset.map((el) => el.id));
  const lines: string[] = [];

  const describeGroup = (items: LiteElement[], indent: string) => {
    const counts: Record<string, number> = {};
    for (const el of items) {
      // Texte lié à une forme décrite ici : déjà repris dans son libellé
      if (el.containerId && inSubset.has(el.containerId)) continue;
      const kind = kindOf(el);
      const label = clip(labelOf(el, byId, boundText));
      const pos = `(${el.x}, ${el.y})`;

      if (kind === "text") {
        lines.push(`${indent}- text ${pos}: "${label}"`);
      } else if (kind === "formula") {
        lines.push(`${indent}- formula ${pos}: ${label}`);
      } else if (kind === "arrow" || kind === "line") {
        const from = el.from ? clip(labelOf(byId.get(el.from)!, byId, boundText)) : "";
        const to = el.to ? clip(labelOf(byId.get(el.to)!, byId, boundText)) : "";
        if (from || to || label) {
          const ends = from || to ? ` from ${from ? `"${from}"` : "?"} to ${to ? `"${to}"` : "?"}` : "";
          lines.push(`${indent}- ${kind}${ends}${label ? ` labelled "${label}"` : ""}`);
        } else {
          counts[kind] = (counts[kind] ?? 0) + 1;
        }
      } else if (kind === "embeddable" || kind === "iframe") {
        lines.push(`${indent}- embed ${pos}: ${el.link ?? ""}`);
      } else if (label) {
        lines.push(`${indent}- ${KIND_NAMES[kind] ?? kind} ${pos} labelled "${label}"${el.link ? ` (link: ${el.link})` : ""}`);
      } else {
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
    }
    if (Object.keys(counts).length) lines.push(`${indent}- also: ${kindsLabel(counts)} (no text)`);
  };

  // Frames présentes dans le sous-ensemble, puis le reste
  const frames = subset.filter(isFrame);
  const frameIds = new Set(frames.map((f) => f.id));
  for (const frame of frames) {
    const children = subset.filter((el) => el.frameId === frame.id);
    lines.push(`Frame "${frame.name ?? "untitled"}" (${frame.width}×${frame.height} at ${frame.x}, ${frame.y}) with ${children.length} elements:`);
    describeGroup(children, "  ");
  }
  const loose = subset.filter((el) => !isFrame(el) && !(el.frameId && frameIds.has(el.frameId)));
  if (loose.length) {
    if (frames.length) lines.push("Outside any frame:");
    describeGroup(loose, frames.length ? "  " : "");
  }
  return lines;
}

function limit(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

// Description de la page entière (contexte joint à chaque question)
export function describeBoard(board: BoardSnapshot): string {
  const name = board.pageName ? `"${board.pageName}"` : "(unnamed)";
  if (board.elements.length === 0) return `The user's current board page ${name} is empty.`;
  const counts: Record<string, number> = {};
  for (const el of board.elements) {
    if (el.containerId) continue;
    const kind = kindOf(el);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const header = `The user's current board page ${name} contains ${kindsLabel(counts)}. Coordinates are in board units, origin top-left, y grows downwards.`;
  return limit([header, ...describeElements(board.elements, board.elements)].join("\n"), MAX_CONTEXT_CHARS);
}

// Sélection courante : textes liés et contenu des frames sélectionnées compris
export function describeSelection(board: BoardSnapshot): { label: string; text: string } | null {
  const sel = new Set(board.selectedIds);
  if (sel.size === 0) return null;
  const chosen = board.elements.filter(
    (el) => sel.has(el.id) || (el.frameId && sel.has(el.frameId)) || (el.containerId && sel.has(el.containerId)),
  );
  if (chosen.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const el of chosen) {
    if (el.containerId && sel.has(el.containerId)) continue;
    if (el.frameId && sel.has(el.frameId) && !sel.has(el.id)) continue; // contenu d'une frame : compté via la frame
    const kind = kindOf(el);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const label = kindsLabel(counts);
  const lines = [`The user selected ${label} on the board:`, ...describeElements(chosen, board.elements)];
  return { label, text: limit(lines.join("\n"), MAX_SELECTION_CHARS) };
}

// ── Capture PNG de la sélection ─────────────────────────────────────
// Export SVG d'Excalidraw (polices et images intégrées), rendu dans un
// canevas. Les petites sélections sont agrandies (jusqu'à ×2) pour rester
// lisibles ; les grandes réduites à `maxSide` px.
export async function captureSelection(maxSide = 1400): Promise<string | null> {
  const result = await callBridgeWithTimeout<{ svg: string; width: number; height: number } | null>(
    15000,
    "exportSelectionSvg",
  );
  if (!result) return null;
  const url = URL.createObjectURL(new Blob([toXml(result.svg)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const w = image.naturalWidth || result.width;
    const h = image.naturalHeight || result.height;
    if (!w || !h) return null;
    const scale = Math.min(2, maxSide / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null; // SVG illisible ou canevas souillé : la description texte suffira
  } finally {
    URL.revokeObjectURL(url);
  }
}
