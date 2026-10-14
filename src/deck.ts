// Diaporama sur toutes les pages : liste ordonnée des slides (frames de chaque
// page), sections façon PowerPoint, aperçus conservés entre deux sessions.
// L'ordre et la section sont rangés sur chaque frame (customData) : ils
// voyagent avec les pages (OneDrive, copie locale, autres PC).
import { runExclusive, syncNow } from "./backup";
import { callBridge } from "./bridgeClient";
import { framesFromElements, readSceneElements, SceneFrame, SectionRef } from "./frames";
import { getPagesIndex, readStoredScene, storedSceneFrames, storeScene } from "./pages";

export interface Slide extends SceneFrame {
  pageId: string;
  pageName: string;
  isCurrentPage: boolean;
}

export const DEFAULT_SECTION: SectionRef = { id: "default", name: "Default Section" };

const COLLAPSED_KEY = "excalihub_collapsed_sections"; // affichage : propre à ce PC
const THUMBS_KEY = "excalihub_thumbs"; // id du frame → image (data URL)
const THUMB_WIDTH = 400;

// ── Lecture ───────────────────────────────────────────────────────────
// Ordre : d'abord l'ordre choisi (global à toutes les pages), puis les slides
// jamais ordonnées, page par page, dans l'ordre par défaut de chaque page.
export async function loadSlides(): Promise<Slide[]> {
  const index = await getPagesIndex();
  const slides: (Slide & { rank: number })[] = [];
  for (const [pageRank, page] of index.pages.entries()) {
    const isCurrentPage = page.id === index.currentId;
    // Pages non affichées : frames gardées en mémoire, sans relire la scène (images comprises)
    const frames = isCurrentPage ? framesFromElements(readSceneElements()) : await storedSceneFrames(page.id);
    frames.forEach((frame, i) =>
      slides.push({
        ...frame,
        pageId: page.id,
        pageName: page.name,
        isCurrentPage,
        rank: frame.order ?? 1e9 + pageRank * 1e4 + i,
      }),
    );
  }
  slides.sort((a, b) => a.rank - b.rank);
  return withEffectiveSections(slides.map(({ rank: _rank, ...slide }) => slide));
}

// Sections contiguës : une slide sans section suit celle d'avant ; tant
// qu'aucune section n'existe, la liste reste à plat (comme PowerPoint).
export function withEffectiveSections(slides: Slide[]): Slide[] {
  if (!slides.some((s) => s.section)) return slides.map((s) => ({ ...s, section: null }));
  let current = DEFAULT_SECTION;
  return slides.map((s) => {
    current = s.section ?? current;
    return { ...s, section: current };
  });
}

export interface SectionGroup {
  section: SectionRef | null;
  start: number; // index de la première slide
  slides: Slide[];
}

export function groupBySection(slides: Slide[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  slides.forEach((slide, i) => {
    const last = groups[groups.length - 1];
    if (last && (last.section?.id ?? null) === (slide.section?.id ?? null)) last.slides.push(slide);
    else groups.push({ section: slide.section, start: i, slides: [slide] });
  });
  return groups;
}

// ── Enregistrement de l'ordre et des sections ────────────────────────
type SlideMeta = { order: number; section: SectionRef | null };

function applyMeta(elements: any[], meta: Record<string, SlideMeta>): { elements: any[]; changed: boolean } {
  let changed = false;
  const next = elements.map((el) => {
    const m = meta[el.id];
    if (el.type !== "frame" || !m) return el;
    const current = el.customData ?? {};
    const sameSection =
      (current.excalihubSection?.id ?? null) === (m.section?.id ?? null) &&
      (current.excalihubSection?.name ?? null) === (m.section?.name ?? null);
    if (current.excalihubSlide === m.order && sameSection) return el;
    changed = true;
    const { excalihubSection: _old, ...rest } = current;
    return {
      ...el,
      customData: { ...rest, excalihubSlide: m.order, ...(m.section ? { excalihubSection: m.section } : {}) },
      version: (el.version ?? 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
  });
  return { elements: next, changed };
}

export async function saveDeck(slides: Slide[]): Promise<void> {
  const effective = withEffectiveSections(slides);
  const byPage = new Map<string, Record<string, SlideMeta>>();
  effective.forEach((slide, order) => {
    const meta = byPage.get(slide.pageId) ?? {};
    meta[slide.id] = { order, section: slide.section };
    byPage.set(slide.pageId, meta);
  });

  let otherPagesChanged = false;
  await runExclusive(async () => {
    const index = await getPagesIndex();
    for (const [pageId, meta] of byPage) {
      if (pageId === index.currentId) {
        await callBridge("setSlideMeta", meta);
        continue;
      }
      const scene = await readStoredScene(pageId);
      if (!scene) continue;
      const { elements, changed } = applyMeta(scene.elements ?? [], meta);
      if (changed) {
        await storeScene(pageId, { ...scene, elements });
        otherPagesChanged = true;
      }
    }
  });
  // Pages non affichées modifiées : on les envoie tout de suite au dossier
  if (otherPagesChanged) syncNow();
}

// ── Sections repliées (affichage de ce PC) ───────────────────────────
export async function loadCollapsed(): Promise<Set<string>> {
  const stored = (await chrome.storage.local.get(COLLAPSED_KEY))[COLLAPSED_KEY];
  return new Set(Array.isArray(stored) ? (stored as string[]) : []);
}

export async function saveCollapsed(collapsed: Set<string>): Promise<void> {
  await chrome.storage.local.set({ [COLLAPSED_KEY]: [...collapsed] });
}

// ── Aperçus conservés ─────────────────────────────────────────────────
// Les aperçus d'une page sont créés quand elle est affichée ; on les garde
// pour les montrer quand on est sur une autre page.
export async function storeThumbnails(captured: Map<string, HTMLCanvasElement>, keepIds: Set<string>): Promise<void> {
  const stored = ((await chrome.storage.local.get(THUMBS_KEY))[THUMBS_KEY] ?? {}) as Record<string, string>;
  for (const id of Object.keys(stored)) if (!keepIds.has(id)) delete stored[id];
  for (const [id, canvas] of captured) {
    try {
      const ratio = Math.min(1, THUMB_WIDTH / canvas.width);
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(canvas.width * ratio));
      small.height = Math.max(1, Math.round(canvas.height * ratio));
      small.getContext("2d")?.drawImage(canvas, 0, 0, small.width, small.height);
      stored[id] = small.toDataURL("image/jpeg", 0.85);
    } catch {
      // Image d'une autre origine dans la slide : aperçu non conservé
    }
  }
  await chrome.storage.local.set({ [THUMBS_KEY]: stored });
}

export async function loadStoredThumbnails(ids: string[]): Promise<Map<string, HTMLCanvasElement>> {
  const stored = ((await chrome.storage.local.get(THUMBS_KEY))[THUMBS_KEY] ?? {}) as Record<string, string>;
  const out = new Map<string, HTMLCanvasElement>();
  await Promise.all(
    ids
      .filter((id) => stored[id])
      .map(async (id) => {
        const image = new Image();
        image.src = stored[id];
        try {
          await image.decode();
        } catch {
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        out.set(id, canvas);
      }),
  );
  return out;
}
