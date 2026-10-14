// Pages : plusieurs dessins dans le même onglet excalidraw.com.
// La page courante vit dans le canevas (sauvegardé par Excalidraw lui-même) ;
// les autres sont rangées dans chrome.storage.local (sur ce PC uniquement).
import { callBridge } from "./bridgeClient";
import { framesFromElements, SceneFrame } from "./frames";

const INDEX_KEY = "excalihub_pages";
const PAGE_PREFIX = "excalihub_page_";
const pageKey = (id: string) => `${PAGE_PREFIX}${id}`;

export interface PageInfo {
  id: string;
  name: string;
  updatedAt: number;
}

export interface PagesIndex {
  pages: PageInfo[];
  currentId: string;
}

export const EMPTY_SCENE = {
  elements: [],
  appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  files: {},
};

// Même calcul que le bridge (nombre d'éléments, somme des versions, fond)
export function sceneSignature(scene: any): string {
  const elements: any[] = scene?.elements ?? [];
  const versions = elements.reduce((sum, el) => sum + (el.version ?? 0), 0);
  return `${elements.length}:${versions}:${scene?.appState?.viewBackgroundColor}`;
}

// Dans une session collaborative, charger une page l'enverrait aux participants
export function isCollabSession(): boolean {
  return /(^|[#&])room=/.test(location.hash);
}

async function writeIndex(index: PagesIndex): Promise<void> {
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

export async function getPagesIndex(): Promise<PagesIndex> {
  const result = await chrome.storage.local.get(INDEX_KEY);
  const index = result[INDEX_KEY] as PagesIndex | undefined;
  if (index && index.pages.length > 0) return index;

  // Première utilisation : le dessin actuel devient « Page 1 »
  const first: PageInfo = { id: crypto.randomUUID(), name: "Page 1", updatedAt: Date.now() };
  const created = { pages: [first], currentId: first.id };
  await writeIndex(created);
  return created;
}

// ── Pages enregistrées : ce qu'on en sait sans les relire ────────────
// Une page enregistrée peut peser des Mo (images). La synchro (toutes les
// 20 s) et l'onglet Slides n'ont besoin que de sa signature et de ses frames :
// calculées à la lecture ou à l'écriture, gardées tant que la page ne change
// pas — ici, ou dans un autre onglet (chrome.storage.onChanged).
interface StoredMeta {
  signature: string;
  frames: SceneFrame[];
}

const metaCache = new Map<string, StoredMeta>();

function remember(id: string, scene: any | null): StoredMeta {
  const meta = {
    signature: sceneSignature(scene ?? EMPTY_SCENE),
    frames: framesFromElements(scene?.elements ?? []),
  };
  metaCache.set(id, meta);
  return meta;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(PAGE_PREFIX)) continue;
    const id = key.slice(PAGE_PREFIX.length);
    if (change.newValue === undefined) metaCache.delete(id);
    else remember(id, change.newValue);
  }
});

async function getStored(id: string): Promise<any | null> {
  const result = await chrome.storage.local.get(pageKey(id));
  return result[pageKey(id)] ?? null;
}

async function storedMeta(id: string): Promise<StoredMeta> {
  return metaCache.get(id) ?? remember(id, await getStored(id));
}

// Signature d'une page non affichée (celle d'une scène vide si jamais enregistrée)
export async function storedSceneSignature(id: string): Promise<string> {
  return (await storedMeta(id)).signature;
}

// Frames (slides) d'une page non affichée
export async function storedSceneFrames(id: string): Promise<SceneFrame[]> {
  return (await storedMeta(id)).frames.map((frame) => ({ ...frame }));
}

async function saveCurrentPage(index: PagesIndex): Promise<void> {
  const scene = await callBridge("getScene");
  await storeScene(index.currentId, scene);
  const page = index.pages.find((p) => p.id === index.currentId);
  if (page) page.updatedAt = Date.now();
}

// Contenu enregistré d'une page non affichée (null si jamais enregistrée)
export async function readStoredScene(id: string): Promise<any | null> {
  const scene = await getStored(id);
  remember(id, scene);
  return scene;
}

// ── Accès bas niveau pour la synchronisation (backup.ts) ─────────────
export const savePagesIndex = writeIndex;

export async function storeScene(id: string, scene: unknown): Promise<void> {
  await chrome.storage.local.set({ [pageKey(id)]: scene });
  remember(id, scene);
}

export async function removeStoredScene(id: string): Promise<void> {
  await chrome.storage.local.remove(pageKey(id));
  metaCache.delete(id);
}

async function loadPage(id: string): Promise<void> {
  await callBridge("loadScene", (await readStoredScene(id)) ?? EMPTY_SCENE);
}

export async function switchToPage(id: string): Promise<void> {
  const index = await getPagesIndex();
  if (id === index.currentId || !index.pages.some((p) => p.id === id)) return;

  await saveCurrentPage(index);
  await loadPage(id);
  index.currentId = id;
  await writeIndex(index);
}

function nextPageName(pages: PageInfo[]): string {
  const names = new Set(pages.map((p) => p.name));
  let n = pages.length + 1;
  while (names.has(`Page ${n}`)) n++;
  return `Page ${n}`;
}

export async function createPage(): Promise<void> {
  const index = await getPagesIndex();
  await saveCurrentPage(index);

  const page: PageInfo = { id: crypto.randomUUID(), name: nextPageName(index.pages), updatedAt: Date.now() };
  index.pages.push(page);
  await callBridge("loadScene", EMPTY_SCENE);
  index.currentId = page.id;
  await writeIndex(index);
}

export async function renamePage(id: string, name: string): Promise<void> {
  const index = await getPagesIndex();
  const page = index.pages.find((p) => p.id === id);
  const trimmed = name.trim();
  if (!page || !trimmed) return;
  page.name = trimmed;
  await writeIndex(index);
}

export async function deletePage(id: string): Promise<void> {
  const index = await getPagesIndex();
  if (index.pages.length <= 1) return;
  const position = index.pages.findIndex((p) => p.id === id);
  if (position < 0) return;

  if (id === index.currentId) {
    // On bascule sur la page voisine sans sauvegarder celle qu'on supprime
    const neighbour = index.pages[position + 1] ?? index.pages[position - 1];
    await loadPage(neighbour.id);
    index.currentId = neighbour.id;
  }

  index.pages.splice(position, 1);
  await writeIndex(index);
  await removeStoredScene(id);
}
