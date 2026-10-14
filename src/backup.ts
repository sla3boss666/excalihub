// Sauvegarde automatique et synchronisation des pages, vers :
// - OneDrive (web) : dossier choisi dans OneDrive, connexion Microsoft, accès
//   depuis n'importe quel PC — le « compte » de l'utilisateur ;
// - ou un dossier de ce PC (API File System Access), en secours.
//
// - Un fichier .excalidraw par page, toujours écrasé par la version la plus
//   récente (pas d'historique daté). Le fichier porte l'id de la page, son nom
//   et la date de sa dernière modification (champ « excalihub », ignoré par
//   Excalidraw qui sait toujours l'ouvrir).
// - Le dossier est relu régulièrement : les pages créées, modifiées, renommées
//   ou supprimées sur un autre PC sont reportées ici. En cas de modification
//   des deux côtés, la plus récente l'emporte.
import { callBridge, waitForExcalidraw } from "./bridgeClient";
import {
  EMPTY_SCENE,
  getPagesIndex,
  isCollabSession,
  PageInfo,
  readStoredScene,
  removeStoredScene,
  savePagesIndex,
  sceneSignature,
  storedSceneSignature,
  storeScene,
} from "./pages";

export type BackupMode = "onedrive" | "local";

export type BackupState =
  | { kind: "none" } // rien de configuré
  | { kind: "onedrive-setup"; step: "client" | "signin" | "folder"; redirectUri: string; message?: string }
  | { kind: "permission"; folder: string } // dossier local : accès à reconfirmer
  | { kind: "ok"; mode: BackupMode; folder: string; savedAt: number | null }
  | { kind: "paused"; folder: string } // session collaborative
  | { kind: "error"; mode: BackupMode; folder: string; message: string };

// Dernier état synchronisé d'une page : son fichier, la date (updatedAt) de la
// version écrite ou importée, et la signature de son contenu à ce moment-là.
interface SyncRecord {
  file: string;
  syncedAt: number;
  signature: string;
}
type SyncRecords = Record<string, SyncRecord>;

// Fichier du dossier distant (local ou OneDrive)
interface Entry {
  name: string;
  lastModified: number;
  ref: any; // FileSystemFileHandle ou id OneDrive
}

interface Backend {
  mode: BackupMode;
  label: string; // affiché : « OneDrive › Excalidraw », nom du dossier local…
  list(): Promise<Entry[]>;
  read(entry: Entry): Promise<string>;
  write(name: string, content: string): Promise<number | null>; // date du fichier écrit, si connue
  remove(name: string): Promise<void>;
}

interface RemotePage {
  file: string;
  entry: Entry;
  pageId: string;
  name: string;
  updatedAt: number;
  data?: any; // contenu déjà téléchargé pendant la lecture du dossier
}

type FileMeta = Pick<RemotePage, "pageId" | "name" | "updatedAt">;

const DB_NAME = "excalihub";
const STORE = "handles";
const HANDLE_KEY = "backupDir";
const MODE_KEY = "excalihub_backup_mode";
const RECORDS_KEY = "excalihub_backup_files";
const CACHE_KEY = "excalihub_backup_cache"; // ce que contient chaque fichier du dossier
const OD_CONFIG_KEY = "excalihub_od_config"; // tenu par le service worker (onedrive.ts)
const OD_TOKENS_KEY = "excalihub_od_tokens";
const DEBOUNCE_MS = 1500; // écriture après la dernière modification…
const MAX_WAIT_MS = 10000; // …et au plus tard, même en dessinant sans pause
const PULL_INTERVAL_MS = 20000; // relecture du dossier
const LOCAL_EDIT_GRACE_MS = 3000; // pas d'import pendant que l'on dessine
const DELETE_GRACE_MS = 30000; // fichier absent depuis 30 s = page supprimée ailleurs

let backend: Backend | null = null;
let localDir: any = null; // FileSystemDirectoryHandle (mode local)
let state: BackupState = { kind: "none" };
let listener: (s: BackupState) => void = () => {};
let pagesListener: () => void = () => {};
let lastSignature = ""; // page affichée, au dernier enregistrement
let lastLocalChange = 0;
let queue: Promise<void> = Promise.resolve(); // écritures et opérations de pages en série
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const missingSince = new Map<string, number>();
// Fichier → page qu'il contient, valable tant que sa date ne change pas : seuls
// les fichiers modifiés ailleurs sont téléchargés. Gardé d'un chargement à l'autre.
const fileCache = new Map<string, { lastModified: number; meta: FileMeta | null }>();
let fileCacheLoaded = false;

function setState(next: BackupState): void {
  state = next;
  listener(next);
}

export function getBackupState(): BackupState {
  return state;
}

// ── Dossier local (File System Access, accès mémorisé dans IndexedDB) ─
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const loadHandle = (key = HANDLE_KEY) => dbRequest<any>("readonly", (s) => s.get(key));
const storeHandle = (handle: any, key = HANDLE_KEY) => dbRequest("readwrite", (s) => s.put(handle, key));
const deleteHandle = (key: string) => dbRequest("readwrite", (s) => s.delete(key));

async function hasPermission(handle: any, request: boolean): Promise<boolean> {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return request && (await handle.requestPermission(options)) === "granted";
}

function localBackend(handle: any): Backend {
  return {
    mode: "local",
    label: handle.name,
    async list() {
      const entries: Entry[] = [];
      for await (const [name, file] of handle.entries()) {
        if (file.kind === "file") entries.push({ name, lastModified: (await file.getFile()).lastModified, ref: file });
      }
      return entries;
    },
    async read(entry) {
      return (await entry.ref.getFile()).text();
    },
    async write(name, content) {
      const file = await handle.getFileHandle(name, { create: true });
      const writable = await file.createWritable(); // remplace le fichier à la fermeture
      await writable.write(content);
      await writable.close();
      return (await file.getFile()).lastModified;
    },
    async remove(name) {
      await handle.removeEntry(name).catch(() => {});
    },
  };
}

// ── OneDrive (requêtes faites par le service worker) ─────────────────
async function od<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error("Extension unreachable: reload the page.");
  if (response.error) {
    throw Object.assign(new Error(response.error.message), { name: response.error.code });
  }
  return response.result as T;
}

function oneDriveBackend(folderName: string): Backend {
  return {
    mode: "onedrive",
    label: `OneDrive › ${folderName}`,
    list: () => od<Entry[]>("od:list"),
    read: (entry) => od<string>("od:read", { id: entry.ref }),
    write: (name, content) => od<number | null>("od:write", { name, content }),
    remove: (name) => od<void>("od:remove", { name }),
  };
}

interface OneDriveStatus {
  clientId: string | null;
  signedIn: boolean;
  folder: { driveId: string; id: string; name: string } | null;
  redirectUri: string;
}

// ── Utilitaires ───────────────────────────────────────────────────────
// Opérations en série : jamais deux écritures (ou une écriture et un
// changement de page) en même temps.
// Une opération bloquée (réseau, dossier) ne doit jamais figer les suivantes :
// au-delà de QUEUE_TIMEOUT_MS, la file passe à la suite.
const QUEUE_TIMEOUT_MS = 90_000;
let queueLength = 0;

export function runExclusive(task: () => Promise<void>): Promise<void> {
  queueLength++;
  const run = queue.catch(() => {}).then(task).finally(() => queueLength--);
  const guard = new Promise<void>((resolve) => setTimeout(resolve, QUEUE_TIMEOUT_MS));
  queue = Promise.race([run.catch(() => {}), guard]);
  return run;
}

// Synchronisation en cours devant une opération de page (affichage « patientez »)
export function isQueueBusy(): boolean {
  return queueLength > 0;
}

// Format .excalidraw standard (se rouvre dans Excalidraw : Ctrl+O ou glisser-déposer)
function toExcalidrawFile(scene: any, page: PageInfo, updatedAt: number): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: scene.elements ?? [],
      appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor ?? "#ffffff" },
      files: scene.files ?? {},
      excalihub: { pageId: page.id, name: page.name, updatedAt },
    },
    null,
    2,
  );
}

// Nom lisible et valide sous Windows et OneDrive, suivi d'un identifiant
// court : deux pages de même nom (créées sur deux PC) n'écrivent jamais le même fichier.
function fileNameFor(page: PageInfo): string {
  const base =
    page.name.replace(/[\\/:*?"<>|#%\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 100) || "Page";
  return `${base} [${page.id.slice(0, 6)}].excalidraw`;
}

async function loadRecords(): Promise<SyncRecords> {
  const stored = await chrome.storage.local.get([RECORDS_KEY, CACHE_KEY]);
  // Cache relu une fois (avant tout enregistrement, qui le réécrit en entier)
  if (!fileCacheLoaded) {
    fileCacheLoaded = true;
    for (const [file, cached] of Object.entries(stored[CACHE_KEY] ?? {})) {
      if (!fileCache.has(file)) fileCache.set(file, cached as { lastModified: number; meta: FileMeta });
    }
  }
  // Ancien format (version sans synchronisation) : id → nom de fichier
  const records: SyncRecords = {};
  for (const [id, value] of Object.entries((stored[RECORDS_KEY] ?? {}) as Record<string, unknown>)) {
    records[id] = typeof value === "string" ? { file: value, syncedAt: 0, signature: "" } : (value as SyncRecord);
  }
  return records;
}

function saveRecords(records: SyncRecords): Promise<void> {
  const cache = [...fileCache].filter(([, cached]) => cached.meta);
  return chrome.storage.local.set({ [RECORDS_KEY]: records, [CACHE_KEY]: Object.fromEntries(cache) });
}

// Fichier que l'on vient d'écrire : inutile de le retélécharger au prochain passage
function rememberWrite(file: string, lastModified: number | null, meta: FileMeta): void {
  if (lastModified) fileCache.set(file, { lastModified, meta });
  else fileCache.delete(file);
}

// Écrit une page dans le dossier (et retire son ancien fichier si elle a été renommée)
async function writePage(target: Backend, page: PageInfo, scene: any, records: SyncRecords): Promise<number> {
  const file = fileNameFor(page);
  const updatedAt = Date.now();
  const written = await target.write(file, toExcalidrawFile(scene, page, updatedAt));
  rememberWrite(file, written, { pageId: page.id, name: page.name, updatedAt });
  const previous = records[page.id];
  if (previous && previous.file.toLowerCase() !== file.toLowerCase()) {
    await target.remove(previous.file);
    fileCache.delete(previous.file);
  }
  records[page.id] = { file, syncedAt: updatedAt, signature: sceneSignature(scene) };
  return updatedAt;
}

// Contenu de la page identique à son fichier du dossier
function isUpToDate(record: SyncRecord | undefined, page: PageInfo, signature: string): boolean {
  return !!record && record.signature === signature && record.file === fileNameFor(page);
}

// Nouveau dossier (ou nouveau mode) : rien à y nettoyer, tout est à resynchroniser
async function resetSyncState(): Promise<void> {
  await chrome.storage.local.remove([RECORDS_KEY, CACHE_KEY]);
  fileCache.clear();
  fileCacheLoaded = true; // plus rien à relire
  missingSince.clear();
  lastSignature = "";
}

function handleError(err: unknown): void {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? String(err);
  const mode = backend?.mode ?? "local";
  const folder = backend?.label ?? "";
  if (mode === "onedrive" && ["signed-out", "not-configured", "no-folder"].includes(name ?? "")) {
    // Connexion expirée, application ou dossier à (re)configurer
    initOneDrive(message);
  } else if (name === "NotAllowedError" || name === "SecurityError") {
    setState({ kind: "permission", folder });
  } else if (name === "NotFoundError") {
    setState({ kind: "error", mode, folder, message: `Folder “${folder}” not found: moved or deleted?` });
  } else {
    setState({ kind: "error", mode, folder, message });
  }
}

function canWrite(): boolean {
  if (!backend || !["ok", "error", "paused"].includes(state.kind)) return false;
  if (isCollabSession()) {
    setState({ kind: "paused", folder: backend.label });
    return false;
  }
  // Pendant le diaporama, rien ne doit changer sous les slides
  return !document.body.classList.contains("excalihub-presenting");
}

function setOk(savedAt: number | null): void {
  if (backend) setState({ kind: "ok", mode: backend.mode, folder: backend.label, savedAt });
}

// ── Lecture du dossier ────────────────────────────────────────────────
// Page la plus récente par id. Les fichiers sans champ « excalihub » (réenregistrés
// par Excalidraw lui-même avec Ctrl+S) sont rattachés à leur page par leur nom.
async function readFolder(records: SyncRecords): Promise<Map<string, RemotePage>> {
  const byFile = new Map(Object.entries(records).map(([id, r]) => [r.file.toLowerCase(), id]));
  const pages = new Map<string, RemotePage>();
  const listed = new Set<string>();

  for (const entry of await backend!.list()) {
    const file = entry.name;
    if (!file.toLowerCase().endsWith(".excalidraw")) continue;
    listed.add(file);
    let cached = fileCache.get(file);
    let data: any = null;
    if (!cached || cached.lastModified !== entry.lastModified) {
      let text: string;
      try {
        text = await backend!.read(entry);
      } catch (err) {
        if ((err as { name?: string })?.name === "NotFoundError") continue; // supprimé entre-temps
        throw err; // réseau… : aucune décision prise sur un dossier lu à moitié
      }
      let meta: FileMeta | null = null;
      try {
        data = JSON.parse(text);
        const pageId = data?.excalihub?.pageId ?? byFile.get(file.toLowerCase());
        if (data?.type === "excalidraw" && pageId) {
          meta = {
            pageId,
            name: data.excalihub?.name ?? file.replace(/( \[[0-9a-f]{6}\])?\.excalidraw$/i, ""),
            updatedAt: data.excalihub?.updatedAt ?? entry.lastModified,
          };
        }
      } catch {
        // Fichier en cours d'écriture ou de synchronisation : relu quand sa date changera
      }
      cached = { lastModified: entry.lastModified, meta };
      fileCache.set(file, cached);
    }
    const meta = cached.meta;
    if (!meta) continue;
    const known = pages.get(meta.pageId);
    if (!known || meta.updatedAt > known.updatedAt) {
      // Contenu gardé seulement s'il va être importé (évite un second téléchargement)
      const record = records[meta.pageId];
      const wanted = data && (!record || meta.updatedAt > record.syncedAt);
      pages.set(meta.pageId, { ...meta, file, entry, data: wanted ? data : undefined });
    }
  }
  // Fichiers disparus du dossier : rien à retenir
  for (const file of [...fileCache.keys()]) if (!listed.has(file)) fileCache.delete(file);
  return pages;
}

async function readRemoteScene(remote: RemotePage): Promise<any> {
  const data = remote.data ?? JSON.parse(await backend!.read(remote.entry));
  return {
    elements: data.elements ?? [],
    appState: { viewBackgroundColor: data.appState?.viewBackgroundColor ?? "#ffffff" },
    files: data.files ?? {},
  };
}

// ── Synchronisation complète ─────────────────────────────────────────
// 1. pages venues d'ailleurs (nouvelles, modifiées, renommées) → ici ;
// 2. pages supprimées ailleurs → supprimées ici ;
// 3. pages créées, modifiées ou renommées ici → dossier ;
// 4. pages supprimées ici → fichier supprimé.
export function syncNow(): Promise<void> {
  return runExclusive(async () => {
    if (!canWrite()) return;
    const target = backend!;
    try {
      const index = await getPagesIndex();
      const records = await loadRecords();
      const remote = await readFolder(records);
      const now = Date.now();
      let indexChanged = false;
      let liveSignature: string = await callBridge("getSignature");
      let reloadCurrent: any = null; // nouvelle scène à afficher

      // Signature actuelle d'une page (canevas pour la page affichée ; les
      // autres sans relire leur contenu, voir pages.ts)
      const localSignature = async (page: PageInfo) =>
        page.id === index.currentId ? liveSignature : await storedSceneSignature(page.id);

      // Nouveau PC : la page vide créée d'office s'efface devant les pages du dossier
      const only = index.pages.length === 1 ? index.pages[0] : null;
      if (only && !records[only.id] && !remote.has(only.id) && remote.size > 0) {
        if ((await localSignature(only)).startsWith("0:")) {
          index.pages = [];
          await removeStoredScene(only.id);
          indexChanged = true;
        }
      }

      // 1. Changements venus du dossier
      for (const [pageId, file] of remote) {
        missingSince.delete(pageId);
        const record = records[pageId];
        let page = index.pages.find((p) => p.id === pageId);
        if (record && file.updatedAt <= record.syncedAt) {
          record.file = file.file; // éventuellement renommé ailleurs, contenu inchangé
          continue;
        }
        if (page && record && (await localSignature(page)) !== record.signature) {
          continue; // modifiée ici aussi, plus récemment : notre version sera écrite
        }
        const isCurrent = page?.id === index.currentId;
        if (isCurrent && (Date.now() - lastLocalChange < LOCAL_EDIT_GRACE_MS || isTyping())) {
          continue; // on dessine en ce moment : import au prochain passage
        }

        const scene = await readRemoteScene(file);
        if (!page) {
          page = { id: pageId, name: file.name, updatedAt: file.updatedAt };
          index.pages.push(page);
        } else {
          page.name = file.name;
          page.updatedAt = file.updatedAt;
        }
        indexChanged = true;
        if (isCurrent) reloadCurrent = scene;
        else await storeScene(pageId, scene);
        records[pageId] = { file: file.file, syncedAt: file.updatedAt, signature: sceneSignature(scene) };
      }

      // 2. Pages supprimées ailleurs (fichier absent assez longtemps, rien changé ici)
      for (const page of [...index.pages]) {
        const record = records[page.id];
        if (!record || remote.has(page.id)) continue;
        const since = missingSince.get(page.id) ?? now;
        missingSince.set(page.id, since);
        if (now - since < DELETE_GRACE_MS) continue;
        missingSince.delete(page.id);
        delete records[page.id];
        if ((await localSignature(page)) !== record.signature) continue; // modifiée ici : réécrite plus bas
        index.pages = index.pages.filter((p) => p.id !== page.id);
        if (page.id !== index.currentId) await removeStoredScene(page.id);
        indexChanged = true;
      }

      // Page affichée disparue (supprimée ailleurs ou page vide remplacée)
      if (!index.pages.some((p) => p.id === index.currentId)) {
        const next = [...index.pages].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) {
          index.currentId = next.id;
          reloadCurrent = (await readStoredScene(next.id)) ?? EMPTY_SCENE;
        } else {
          const fresh: PageInfo = { id: crypto.randomUUID(), name: "Page 1", updatedAt: now };
          index.pages.push(fresh);
          index.currentId = fresh.id;
          reloadCurrent = EMPTY_SCENE;
        }
        indexChanged = true;
      }

      if (indexChanged) await savePagesIndex(index);
      if (reloadCurrent) {
        // Signature retenue avant le chargement : l'import ne doit pas être réécrit
        lastSignature = liveSignature = sceneSignature(reloadCurrent);
        await callBridge("loadScene", reloadCurrent);
        await removeStoredScene(index.currentId); // la page affichée vit dans le canevas
      }

      // 3. Pages créées, modifiées ou renommées ici
      for (const page of index.pages) {
        const signature = await localSignature(page);
        if (isUpToDate(records[page.id], page, signature)) {
          if (page.id === index.currentId) lastSignature = signature; // pas de réenvoi à l'affichage
          continue;
        }

        const scene =
          page.id === index.currentId ? await callBridge("getScene") : await readStoredScene(page.id);
        if (!scene) continue;
        await writePage(target, page, scene, records);
        if (page.id === index.currentId) lastSignature = records[page.id].signature;
      }

      // 4. Pages supprimées ici : leur fichier aussi
      for (const [id, record] of Object.entries(records)) {
        if (index.pages.some((p) => p.id === id)) continue;
        await target.remove(record.file);
        fileCache.delete(record.file);
        delete records[id];
      }

      await saveRecords(records);
      if (backend === target) setOk(Date.now());
      if (indexChanged) pagesListener();
    } catch (err) {
      if (backend === target) handleError(err);
    }
    await updateMirror(false); // y compris les pages reçues d'un autre PC
  });
}

// Après un simple changement de page : seule la page quittée peut avoir des
// modifications pas encore envoyées (faites juste avant le clic). Rien à
// télécharger : la relecture du dossier attend le prochain passage.
export function pushPage(pageId: string): Promise<void> {
  return runExclusive(async () => {
    if (!canWrite()) return;
    const target = backend!;
    try {
      const index = await getPagesIndex();
      const records = await loadRecords();
      // Page ouverte déjà à jour dans le dossier : pas de réenvoi à son affichage
      const opened = index.pages.find((p) => p.id === index.currentId);
      const live = await callBridge<string>("getSignature");
      if (opened && isUpToDate(records[opened.id], opened, live)) lastSignature = live;

      const page = index.pages.find((p) => p.id === pageId);
      if (!page || page.id === index.currentId) return;
      const scene = await readStoredScene(page.id);
      if (!scene || isUpToDate(records[page.id], page, sceneSignature(scene))) return;
      const updatedAt = await writePage(target, page, scene, records);
      await saveRecords(records);
      if (backend === target) setOk(updatedAt);
    } catch (err) {
      if (backend === target) handleError(err);
    }
  });
}

// ── Copie locale (en plus de OneDrive) ────────────────────────────────
// Dossier de ce PC tenu à jour en permanence, même quand OneDrive est
// injoignable (hors ligne, connexion expirée) : toujours la dernière version.
export type MirrorState =
  | { kind: "off" }
  | { kind: "permission"; folder: string } // accès à reconfirmer (redémarrage du navigateur)
  | { kind: "ok"; folder: string; savedAt: number | null }
  | { kind: "error"; folder: string; message: string };

const MIRROR_KEY = "mirrorDir";
let mirrorDir: any = null;
let mirror: MirrorState = { kind: "off" };
const mirrorSignatures = new Map<string, string>(); // fichier → contenu déjà écrit

export function getMirrorState(): MirrorState {
  return mirror;
}

function setMirror(next: MirrorState): void {
  mirror = next;
  listener(state); // le panneau affiche les deux états
}

const mirrorActive = () => !!mirrorDir && (mirror.kind === "ok" || mirror.kind === "error");

// Écrit dans la copie locale les pages qui ont changé ; `onlyCurrent` pour
// l'enregistrement continu, sinon toutes les pages + ménage des fichiers
// de pages supprimées ou renommées.
async function updateMirror(onlyCurrent: boolean, currentScene?: any): Promise<void> {
  if (!mirrorActive() || isCollabSession()) return;
  const folder = localBackend(mirrorDir);
  try {
    const index = await getPagesIndex();
    const records = await loadRecords();
    const names = new Set<string>();
    for (const page of index.pages) {
      const file = fileNameFor(page);
      names.add(file.toLowerCase());
      if (onlyCurrent && page.id !== index.currentId) continue;
      const isCurrent = page.id === index.currentId;
      // Signature légère d'abord (canevas, ou cache des pages enregistrées) :
      // la scène complète n'est relue que s'il y a quelque chose à écrire
      const quick = isCurrent
        ? currentScene
          ? null
          : await callBridge<string>("getSignature")
        : await storedSceneSignature(page.id);
      if (quick && mirrorSignatures.get(file) === quick) continue;
      const scene = isCurrent ? (currentScene ?? (await callBridge("getScene"))) : await readStoredScene(page.id);
      if (!scene) continue;
      const signature = sceneSignature(scene);
      if (mirrorSignatures.get(file) === signature) continue;
      await folder.write(file, toExcalidrawFile(scene, page, records[page.id]?.syncedAt ?? Date.now()));
      mirrorSignatures.set(file, signature);
    }
    if (!onlyCurrent) {
      for (const entry of await folder.list()) {
        // Seulement nos fichiers (« Nom [abc123].excalidraw »)
        if (/ \[[0-9a-z-]{6}\]\.excalidraw$/i.test(entry.name) && !names.has(entry.name.toLowerCase())) {
          await folder.remove(entry.name);
          mirrorSignatures.delete(entry.name);
        }
      }
    }
    setMirror({ kind: "ok", folder: mirrorDir.name, savedAt: Date.now() });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      setMirror({ kind: "permission", folder: mirrorDir.name });
    } else {
      const message =
        name === "NotFoundError" ? "Folder not found: moved or deleted?" : ((err as Error)?.message ?? String(err));
      setMirror({ kind: "error", folder: mirrorDir.name, message });
    }
  }
}

export async function chooseMirrorFolder(): Promise<void> {
  const picker = (window as any).showDirectoryPicker;
  if (!picker) throw new Error("This browser cannot write to a folder (Chrome or Edge required).");
  const handle = await picker({ id: "excalihub-mirror", mode: "readwrite", startIn: "documents" });
  mirrorDir = handle;
  await storeHandle(handle, MIRROR_KEY);
  mirrorSignatures.clear();
  setMirror({ kind: "ok", folder: handle.name, savedAt: null });
  await runExclusive(() => updateMirror(false));
}

export async function resumeMirror(): Promise<void> {
  if (!mirrorDir) return chooseMirrorFolder();
  if (!(await hasPermission(mirrorDir, true))) {
    setMirror({ kind: "permission", folder: mirrorDir.name });
    return;
  }
  setMirror({ kind: "ok", folder: mirrorDir.name, savedAt: null });
  await runExclusive(() => updateMirror(false));
}

export async function disableMirror(): Promise<void> {
  mirrorDir = null;
  mirrorSignatures.clear();
  await deleteHandle(MIRROR_KEY);
  setMirror({ kind: "off" });
}

async function initMirror(): Promise<void> {
  try {
    mirrorDir = (await loadHandle(MIRROR_KEY)) ?? null;
  } catch {
    mirrorDir = null;
  }
  if (!mirrorDir) return setMirror({ kind: "off" });
  if (!(await hasPermission(mirrorDir, false).catch(() => false))) {
    return setMirror({ kind: "permission", folder: mirrorDir.name });
  }
  setMirror({ kind: "ok", folder: mirrorDir.name, savedAt: null });
  if (await waitForExcalidraw()) await runExclusive(() => updateMirror(false));
}

// ── Enregistrement continu de la page affichée ───────────────────────
function saveCurrentPage(): Promise<void> {
  return runExclusive(async () => {
    const primary = canWrite();
    if (!primary && !mirrorActive()) return;
    const target = backend;
    let scene: any = null;
    try {
      scene = await callBridge("getScene");
      const signature = sceneSignature(scene);
      if (!primary || !target || signature === lastSignature) return;
      const index = await getPagesIndex();
      const page = index.pages.find((p) => p.id === index.currentId);
      if (!page) return;

      const records = await loadRecords();
      // Page que l'on vient d'ouvrir (ou d'importer) : déjà à jour dans le dossier
      if (!isUpToDate(records[page.id], page, signature)) {
        const updatedAt = await writePage(target, page, scene, records);
        await saveRecords(records);
        if (backend === target) setOk(updatedAt);
      }
      lastSignature = signature;
    } catch (err) {
      if (target && backend === target) handleError(err);
    } finally {
      // La copie locale suit, que OneDrive ait répondu ou non
      if (scene) await updateMirror(true, scene);
    }
  });
}

function isTyping(): boolean {
  return document.querySelector(".excalidraw-wysiwyg") !== null;
}

function flush(): void {
  if (stopped) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (maxTimer) clearTimeout(maxTimer);
  debounceTimer = maxTimer = null;
  saveCurrentPage();
}

// Signalé par le bridge à chaque modification (signature calculée côté page)
export function onSceneChanged(signature: string): void {
  if (stopped) return;
  const primary = !!backend && ["ok", "error", "paused"].includes(state.kind);
  if (!primary && !mirrorActive()) return;
  // Défilement, zoom, sélection : rien à enregistrer
  const mirrored = !mirrorActive() || [...mirrorSignatures.values()].includes(signature);
  if (signature === lastSignature && mirrored) return;
  lastLocalChange = Date.now();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  maxTimer ??= setTimeout(flush, MAX_WAIT_MS);
}

let stopped = false;

// Extension rechargée ou mise à jour : cette copie du script est coupée de
// l'extension, on arrête tout (la nouvelle version démarre au rechargement de la page)
export function stopBackup(): void {
  stopped = true;
  for (const timer of [syncTimer, debounceTimer, maxTimer]) if (timer) clearTimeout(timer);
  syncTimer = debounceTimer = maxTimer = null;
}

// Relecture du dossier : au retour sur l'onglet, puis toutes les 20 s
function scheduleSync(delay: number): void {
  if (stopped) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    // « paused » inclus : la synchro reprend seule après une session collaborative
    if (document.visibilityState === "visible" && ["ok", "error", "paused"].includes(state.kind)) {
      await syncNow();
    } else if (mirrorActive()) {
      await runExclusive(() => updateMirror(false)); // OneDrive indisponible : la copie locale continue
    }
    scheduleSync(PULL_INTERVAL_MS);
  }, delay);
}

async function start(next: Backend): Promise<void> {
  backend = next;
  setOk(null);
  if (await waitForExcalidraw()) await syncNow();
  scheduleSync(PULL_INTERVAL_MS);
}

// ── Mode OneDrive ─────────────────────────────────────────────────────
// Étapes : identifiant d'application → connexion Microsoft → choix du dossier.
async function initOneDrive(message?: string): Promise<void> {
  backend = null;
  let status: OneDriveStatus;
  try {
    status = await od<OneDriveStatus>("od:status");
  } catch (err) {
    setState({ kind: "error", mode: "onedrive", folder: "OneDrive", message: (err as Error).message });
    return;
  }
  const setup = (step: "client" | "signin" | "folder") =>
    setState({ kind: "onedrive-setup", step, redirectUri: status.redirectUri, message });
  if (!status.clientId) return setup("client");
  if (!status.signedIn) return setup("signin");
  if (!status.folder) return setup("folder");
  await start(oneDriveBackend(status.folder.name));
}

export async function chooseOneDrive(): Promise<void> {
  await chrome.storage.local.set({ [MODE_KEY]: "onedrive" });
  await resetSyncState();
  await initOneDrive();
}

export async function saveOneDriveClientId(clientId: string): Promise<void> {
  await od("od:setClientId", { clientId });
  await initOneDrive();
}

export async function signInOneDrive(): Promise<void> {
  await od("od:signIn");
  await initOneDrive();
}

export async function signOutOneDrive(): Promise<void> {
  await od("od:signOut");
  await initOneDrive();
}

// Ouvre la fenêtre de choix du dossier (sélecteur OneDrive web) ; le choix
// revient par chrome.storage (voir initBackup)
export async function pickOneDriveFolder(): Promise<void> {
  await od("od:openPicker");
}

// ── Mode dossier local ────────────────────────────────────────────────
export async function chooseLocalFolder(): Promise<void> {
  const picker = (window as any).showDirectoryPicker;
  if (!picker) throw new Error("This browser cannot write to a folder (Chrome or Edge required).");
  const handle = await picker({ id: "excalihub-backup", mode: "readwrite", startIn: "documents" });
  localDir = handle;
  await storeHandle(handle);
  await chrome.storage.local.set({ [MODE_KEY]: "local" });
  await resetSyncState();
  await start(localBackend(handle));
}

// Après un redémarrage du navigateur, l'accès au dossier local doit être
// confirmé d'un clic (Chrome propose alors « Autoriser à chaque visite »).
export async function resumeBackup(): Promise<void> {
  if (backend?.mode === "onedrive" || state.kind === "onedrive-setup") return initOneDrive();
  if (!localDir) return chooseLocalFolder();
  if (!(await hasPermission(localDir, true))) {
    setState({ kind: "permission", folder: localDir.name });
    return;
  }
  await start(localBackend(localDir));
}

export async function initBackup(onState: (s: BackupState) => void, onPagesChanged: () => void): Promise<void> {
  listener = onState;
  pagesListener = onPagesChanged;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Onglet masqué ou fermé : on enregistre sans attendre la fin du délai
      if (debounceTimer || maxTimer) flush();
    } else {
      scheduleSync(300); // retour sur l'onglet : on récupère le travail fait ailleurs
    }
  });
  window.addEventListener("focus", () => scheduleSync(300));

  // Connexion, déconnexion ou nouveau dossier OneDrive (fenêtre de choix,
  // autre onglet…) : on reprend la configuration
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const mode = (await chrome.storage.local.get(MODE_KEY))[MODE_KEY];
    if (mode !== "onedrive") return;
    const config = changes[OD_CONFIG_KEY] as
      | { newValue?: { folder?: { id: string } }; oldValue?: { folder?: { id: string } } }
      | undefined;
    const folderChanged = !!config && config.newValue?.folder?.id !== config.oldValue?.folder?.id;
    if (folderChanged) await resetSyncState();
    if (folderChanged || (changes[OD_TOKENS_KEY] && state.kind !== "ok")) await initOneDrive();
  });

  // Copie locale indépendante de OneDrive, relue en tâche de fond
  initMirror();
  scheduleSync(PULL_INTERVAL_MS);

  const mode = (await chrome.storage.local.get(MODE_KEY))[MODE_KEY] as BackupMode | undefined;
  if (mode === "onedrive") {
    await initOneDrive();
    return;
  }

  // Dossier local (aussi pour les versions précédentes, sans mode enregistré)
  try {
    localDir = (await loadHandle()) ?? null;
  } catch {
    localDir = null;
  }
  if (!localDir) {
    setState({ kind: "none" });
    return;
  }
  if (!(await hasPermission(localDir, false).catch(() => false))) {
    setState({ kind: "permission", folder: localDir.name });
    return;
  }
  await start(localBackend(localDir));
}
