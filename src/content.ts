// Pages, présentation des frames, formules LaTeX, sauvegarde et synchronisation.
// Seul réseau : Microsoft (connexion et OneDrive), quand la synchro OneDrive est activée.
import {
  BackupState,
  chooseLocalFolder,
  chooseMirrorFolder,
  chooseOneDrive,
  disableMirror,
  getBackupState,
  getMirrorState,
  initBackup,
  isQueueBusy,
  onSceneChanged,
  pickOneDriveFolder,
  resumeBackup,
  resumeMirror,
  runExclusive,
  saveOneDriveClientId,
  stopBackup,
  signInOneDrive,
  signOutOneDrive,
  syncNow,
} from "./backup";
import { callBridge } from "./bridgeClient";
import { canvasFilter, captureThumbnails } from "./capture";
import {
  DEFAULT_SECTION,
  groupBySection,
  loadCollapsed,
  loadSlides,
  loadStoredThumbnails,
  saveCollapsed,
  saveDeck,
  SectionGroup,
  Slide,
  storeThumbnails,
  withEffectiveSections,
} from "./deck";
import { getFramesFromScene, getSceneVersion } from "./frames";
import { createPage, deletePage, getPagesIndex, isCollabSession, PageInfo, renamePage, switchToPage } from "./pages";
import {
  DEFAULT_TRANSITION,
  enterPresentationMode,
  TransitionOptions,
  TransitionType,
  TRANSITIONS,
} from "./presentation";
import { getExcalidrawTheme } from "./theme";

// ── Réglage de la transition (mémorisé dans le localStorage de la page) ─
const TRANSITION_KEY = "excalihub-pres-transition";
const TRANSITION_DURATIONS = [300, 600, 1000];

function loadTransition(): TransitionOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(TRANSITION_KEY) ?? "null");
    if (TRANSITIONS.some((t) => t.type === saved?.type) && TRANSITION_DURATIONS.includes(saved?.duration)) {
      return saved;
    }
  } catch {
    // Valeur absente ou illisible : on garde le défaut
  }
  return DEFAULT_TRANSITION;
}

function saveTransition(t: TransitionOptions): void {
  try {
    localStorage.setItem(TRANSITION_KEY, JSON.stringify(t));
  } catch {
    // Stockage indisponible : le réglage vaut pour cette session seulement
  }
}

function readTransitionInputs(): TransitionOptions {
  const type = (document.getElementById("excalihub-pres-transition") as HTMLSelectElement).value as TransitionType;
  const duration = Number((document.getElementById("excalihub-pres-duration") as HTMLSelectElement).value);
  return { type, duration };
}

// ── Thème ─────────────────────────────────────────────────────────────
function applyTheme(): void {
  const isDark = getExcalidrawTheme() === "dark";
  document.getElementById("excalihub-panel")?.classList.toggle("theme-dark", isDark);
  document.getElementById("excalihub-toggle")?.classList.toggle("theme-dark", isDark);
}

function observeTheme(): void {
  const observer = new MutationObserver(() => applyTheme());

  function tryObserve(): void {
    const target = document.querySelector(".excalidraw");
    if (target) {
      observer.observe(target, { attributes: true, attributeFilter: ["class"] });
      applyTheme();
    } else {
      // .excalidraw pas encore dans le DOM — on réessaie
      requestAnimationFrame(tryObserve);
    }
  }

  tryObserve();
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

const svg = (paths: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICON_PLAY = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
const ICON_PLUS = `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`;
const ICON_EDIT = `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>`;
const ICON_TRASH = `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>`;
const ICON_CLOSE = `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`;
const ICON_REFRESH = `<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>`;

// ── Message temporaire (erreurs de formule…) ─────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  let toast = document.getElementById("excalihub-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "excalihub-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast!.classList.remove("show"), 6000);
}

// ── Formules LaTeX ────────────────────────────────────────────────────
// Le bridge signale les textes contenant des $ ; on les rend ici avec MathJax
// (module chargé à la première formule) et on lui renvoie les images.
type LatexModule = typeof import("./latex");
const LATEX_SETTING_KEY = "excalihub-latex"; // lu aussi par le bridge

interface LatexCandidate {
  id: string;
  version: number;
  source: string;
  fontSize: number;
  color: string;
  align: string;
}

let latexModule: Promise<LatexModule> | null = null;

function loadLatex(): Promise<LatexModule> {
  latexModule ??= import(/* @vite-ignore */ chrome.runtime.getURL("dist/latex.js"));
  return latexModule;
}

function svgToDataURL(svg: string): string {
  let binary = "";
  new TextEncoder().encode(svg).forEach((b) => (binary += String.fromCharCode(b)));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

async function convertFormulas(items: LatexCandidate[]): Promise<void> {
  let latex: LatexModule;
  try {
    latex = await loadLatex();
  } catch {
    showToast("Could not load the LaTeX engine. Reload the page.");
    return;
  }

  const results = [];
  for (const item of items) {
    const tex = latex.sourceToTex(item.source, item.align);
    if (tex === null) continue; // des $ mais pas de formule : texte ordinaire
    try {
      const formula = latex.renderTex(tex, item.fontSize, item.color);
      results.push({
        id: item.id,
        version: item.version,
        dataURL: svgToDataURL(formula.svg),
        width: formula.width,
        height: formula.height,
      });
    } catch (err) {
      // MathJax lève des TexError, qui ne dérivent pas d'Error mais ont un message
      const message = (err as { message?: string })?.message ?? String(err);
      showToast(`Invalid LaTeX formula: ${message}`);
    }
  }
  if (results.length) await callBridge("replaceWithFormulas", results).catch(() => {});
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "excalihub-bridge-event" || !extensionAlive()) return;
  if (e.data.type === "latex-candidates") convertFormulas(e.data.items);
  if (e.data.type === "scene-changed") onSceneChanged(e.data.signature);
  if (e.data.type === "toggle-panel") togglePanel();
});

// ── Sauvegarde automatique : état affiché en tête de l'onglet Pages ───
const ICON_FOLDER = `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`;

function renderBackup(s: BackupState): void {
  const needsAction = ["none", "onedrive-setup", "permission", "error"].includes(s.kind);
  const m = getMirrorState();
  const mirrorNeedsAction = m.kind === "permission" || m.kind === "error";
  document.getElementById("excalihub-toggle")?.classList.toggle("needs-attention", needsAction || mirrorNeedsAction);
  const box = document.getElementById("excalihub-backup");
  if (!box) return;

  box.className = `excalihub-backup ${needsAction ? "warn" : ""}`;
  const folder = "folder" in s ? `“${escapeHtml(s.folder)}”` : "";
  const isOneDrive = ("mode" in s && s.mode === "onedrive") || s.kind === "onedrive-setup";
  const change = isOneDrive
    ? `<button class="excalihub-link-btn" data-backup="pick">Change folder</button>`
    : `<button class="excalihub-link-btn" data-backup="local">Change folder</button>`;
  const link = (action: string, label: string) =>
    `<button class="excalihub-link-btn" data-backup="${action}">${label}</button>`;

  if (s.kind === "none") {
    box.innerHTML = `
      <p class="excalihub-backup-title">${svg(ICON_FOLDER)} Auto-save is off</p>
      <p>With OneDrive, your pages are saved to your Microsoft account, always in their latest
        version, and you get them back on all your PCs.</p>
      <div class="excalihub-backup-actions">
        <button class="excalihub-btn primary" data-backup="onedrive">Sync with OneDrive</button>
        ${link("local", "Folder on this PC")}
      </div>`;
  } else if (s.kind === "onedrive-setup") {
    const note = s.message ? `<p class="excalihub-backup-note">${escapeHtml(s.message)}</p>` : "";
    if (s.step === "client") {
      box.innerHTML = `
        <p class="excalihub-backup-title">${svg(ICON_FOLDER)} OneDrive — step 1/3: Microsoft app</p>
        ${note}
        <p>Register the Excalihub app in the Azure portal (see the guide) with this redirect URI
          (type “Single-page application”):</p>
        <div class="excalihub-backup-field">
          <code>${escapeHtml(s.redirectUri)}</code>
          ${link("copy-redirect", "Copy")}
        </div>
        <p>Then paste the Application (client) ID:</p>
        <div class="excalihub-backup-field">
          <input id="excalihub-od-client" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" />
          <button class="excalihub-btn primary" data-backup="save-client">OK</button>
        </div>
        ${link("local", "Use a folder on this PC instead")}`;
    } else if (s.step === "signin") {
      box.innerHTML = `
        <p class="excalihub-backup-title">${svg(ICON_FOLDER)} OneDrive — step 2/3: sign in</p>
        ${note}
        <p>Sign in with your personal Microsoft account.</p>
        <div class="excalihub-backup-actions">
          <button class="excalihub-btn primary" data-backup="signin">Sign in to OneDrive</button>
          ${link("edit-client", "Change the ID")}
        </div>`;
    } else {
      box.innerHTML = `
        <p class="excalihub-backup-title">${svg(ICON_FOLDER)} OneDrive — step 3/3: folder</p>
        ${note}
        <p>Choose the OneDrive folder for your pages (the same one on all your PCs).</p>
        <div class="excalihub-backup-actions">
          <button class="excalihub-btn primary" data-backup="pick">Choose the folder in OneDrive</button>
          ${link("signout", "Sign out")}
        </div>`;
    }
  } else if (s.kind === "permission") {
    box.innerHTML = `
      <p class="excalihub-backup-title">${svg(ICON_FOLDER)} Auto-save on hold</p>
      <p>The browser asks you to confirm access to ${folder}. Choose “Allow on every visit” so you don't have to do it again.</p>
      <button class="excalihub-btn primary" data-backup="resume">Resume auto-save</button>`;
  } else if (s.kind === "paused") {
    box.innerHTML = `
      <p class="excalihub-backup-title">${svg(ICON_FOLDER)} Auto-save paused</p>
      <p>No saving during a live collaboration session.</p>`;
  } else if (s.kind === "error") {
    box.innerHTML = `
      <p class="excalihub-backup-title">${svg(ICON_FOLDER)} Auto-save failed</p>
      <p>${escapeHtml(s.message)}</p>
      <div class="excalihub-backup-actions">
        <button class="excalihub-btn primary" data-backup="resume">Retry</button>${change}
      </div>`;
  } else {
    const time = s.savedAt ? new Date(s.savedAt).toLocaleTimeString("en-GB") : "…";
    box.innerHTML = `
      <p class="excalihub-backup-title ok">${svg(ICON_FOLDER)} Synced with ${folder} at ${time}</p>
      <div class="excalihub-backup-actions">
        ${change}
        ${s.mode === "onedrive" ? link("signout", "Sign out") : link("onedrive", "Switch to OneDrive")}
      </div>`;
  }
  if (isOneDrive) box.insertAdjacentHTML("beforeend", renderMirror(m));
}

// Copie locale, affichée sous l'état OneDrive
function renderMirror(m: ReturnType<typeof getMirrorState>): string {
  const link = (action: string, label: string) =>
    `<button class="excalihub-link-btn" data-backup="${action}">${label}</button>`;
  const folder = "folder" in m ? `“${escapeHtml(m.folder)}”` : "";
  let body: string;
  if (m.kind === "off") {
    body = `<p>Local copy: none. ${link("mirror-choose", "Add a copy on this PC")}</p>`;
  } else if (m.kind === "permission") {
    body = `<p class="excalihub-backup-note">Local copy ${folder} on hold (browser restarted).</p>
      <button class="excalihub-btn primary" data-backup="mirror-resume">Resume local copy</button>`;
  } else if (m.kind === "error") {
    body = `<p class="excalihub-backup-note">Local copy failed: ${escapeHtml(m.message)}</p>
      <div class="excalihub-backup-actions">${link("mirror-resume", "Retry")} ${link("mirror-choose", "Change folder")}</div>`;
  } else {
    const time = m.savedAt ? new Date(m.savedAt).toLocaleTimeString("en-GB") : "…";
    body = `<p>Local copy in ${folder} at ${time}</p>
      <div class="excalihub-backup-actions">${link("mirror-choose", "Change folder")} ${link("mirror-off", "Stop")}</div>`;
  }
  return `<div class="excalihub-mirror">${body}</div>`;
}

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runBackupAction(action: string): Promise<void> {
  const s = getBackupState();
  switch (action) {
    case "onedrive":
      return chooseOneDrive();
    case "local":
      return chooseLocalFolder();
    case "copy-redirect":
      if (s.kind === "onedrive-setup") {
        await navigator.clipboard.writeText(s.redirectUri);
        showToast("Redirect URI copied.");
      }
      return;
    case "save-client": {
      const value = (document.getElementById("excalihub-od-client") as HTMLInputElement).value.trim();
      if (!CLIENT_ID_PATTERN.test(value)) {
        showToast("Invalid ID: copy the “Application (client) ID” from the Azure portal.");
        return;
      }
      return saveOneDriveClientId(value);
    }
    case "edit-client":
      if (s.kind === "onedrive-setup") renderBackup({ ...s, step: "client", message: undefined });
      return;
    case "signin":
      return signInOneDrive();
    case "signout":
      return signOutOneDrive();
    case "pick":
      return pickOneDriveFolder();
    case "mirror-choose":
      return chooseMirrorFolder();
    case "mirror-resume":
      return resumeMirror();
    case "mirror-off":
      return disableMirror();
    default:
      return resumeBackup();
  }
}

function initBackupBox(): void {
  const box = document.getElementById("excalihub-backup")!;
  box.addEventListener("click", async (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-backup]")?.dataset.backup;
    if (!action) return;
    try {
      await runBackupAction(action);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return; // sélecteur fermé
      showToast(`Auto-save: ${(err as { message?: string })?.message ?? String(err)}`);
    }
  });
  // Saisie de l'identifiant : pas de raccourcis Excalidraw, Entrée valide
  box.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName !== "INPUT") return;
    e.stopPropagation();
    if (e.key === "Enter") runBackupAction("save-client").catch((err) => showToast(String(err?.message ?? err)));
  });
}

async function startBackup(): Promise<void> {
  // Pages arrivées, modifiées ou supprimées depuis un autre PC
  const onRemotePages = () => {
    thumbsVersion = -1;
    if (isPanelOpen() && activeTab === "pages") renderPages();
    if (isPanelOpen() && activeTab === "slides") reloadSlides();
  };
  await initBackup(renderBackup, onRemotePages);
  // Rappel une fois par session tant que la sauvegarde n'est pas active
  const s = getBackupState();
  if (!["none", "onedrive-setup", "permission"].includes(s.kind)) return;
  try {
    if (sessionStorage.getItem("excalihub-backup-reminded")) return;
    sessionStorage.setItem("excalihub-backup-reminded", "1");
  } catch {
    // Stockage de session indisponible : rappel à chaque chargement
  }
  showToast(
    s.kind === "permission"
      ? "Auto-save on hold: press Ctrl+X › Pages › Resume auto-save."
      : "Auto-save is not set up yet: press Ctrl+X › Pages.",
  );
}

function latexEnabled(): boolean {
  try {
    return localStorage.getItem(LATEX_SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

function setLatexEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(LATEX_SETTING_KEY);
    else localStorage.setItem(LATEX_SETTING_KEY, "off");
  } catch {
    // Stockage indisponible : réglage non mémorisé
  }
}

// ── Onglets ───────────────────────────────────────────────────────────
type Tab = "pages" | "slides" | "latex";
let activeTab: Tab = "slides";

function showTab(tab: Tab): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>(".excalihub-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".excalihub-tab-view").forEach((el) => {
    el.hidden = el.dataset.view !== tab;
  });

  if (tab === "slides") {
    openSlidesTab();
    return;
  }
  stopPresPolling();
  if (tab === "pages") renderPages();
}

function isPanelOpen(): boolean {
  return document.getElementById("excalihub-panel")!.classList.contains("open");
}

function openPanel(): void {
  document.getElementById("excalihub-panel")!.classList.add("open");
  document.getElementById("excalihub-toggle")!.classList.add("shifted");
  showTab(activeTab);
}

function togglePanel(): void {
  if (isPanelOpen()) closePanel();
  else openPanel();
}

function closePanel(): void {
  stopPresPolling();
  document.getElementById("excalihub-panel")!.classList.remove("open");
  document.getElementById("excalihub-toggle")!.classList.remove("shifted");
}

// ── Onglet Pages ──────────────────────────────────────────────────────
let pagesBusy = false;

function buildPageItem(page: PageInfo, isCurrent: boolean, canDelete: boolean): HTMLElement {
  const item = document.createElement("div");
  item.className = `excalihub-page-item${isCurrent ? " active" : ""}`;
  item.dataset.id = page.id;
  item.title = isCurrent ? "Current page" : "Click to open this page";
  item.innerHTML = `
    <span class="excalihub-page-name">${escapeHtml(page.name)}</span>
    <span class="excalihub-page-actions">
      <button class="excalihub-icon-btn" data-action="rename" title="Rename">${svg(ICON_EDIT)}</button>
      ${canDelete ? `<button class="excalihub-icon-btn danger" data-action="delete" title="Delete">${svg(ICON_TRASH)}</button>` : ""}
    </span>
  `;
  return item;
}

async function renderPages(): Promise<void> {
  const list = document.getElementById("excalihub-pages-list")!;
  const newBtn = document.getElementById("excalihub-page-new") as HTMLButtonElement;

  if (isCollabSession()) {
    newBtn.disabled = true;
    list.innerHTML = `
      <div class="excalihub-pres-empty">
        <p>Pages are not available during a live collaboration session.</p>
        <p>Switching pages would send its content to the participants.</p>
      </div>
    `;
    return;
  }

  newBtn.disabled = false;
  const index = await getPagesIndex();
  list.replaceChildren(
    ...index.pages.map((p) => buildPageItem(p, p.id === index.currentId, index.pages.length > 1)),
  );
}

// Toute opération qui change le canevas passe par ici (une seule à la fois)
async function runPageOperation(operation: () => Promise<void>): Promise<void> {
  if (pagesBusy) return;
  pagesBusy = true;
  const list = document.getElementById("excalihub-pages-list")!;
  list.classList.add("busy");
  // Une synchro en cours passe d'abord : on le dit au lieu de laisser la liste grisée
  if (isQueueBusy()) list.dataset.waiting = "Waiting for sync to finish…";
  try {
    // Jamais pendant une écriture de sauvegarde (et inversement)
    await runExclusive(operation);
    // Nouvelle scène : aperçus et liste de slides à refaire
    thumbsVersion = -1;
    // Le dossier de sauvegarde reflète les pages (création, suppression…)
    syncNow();
  } catch (err) {
    alert(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    pagesBusy = false;
    list.classList.remove("busy");
    delete list.dataset.waiting;
    await renderPages();
  }
}

function startRename(item: HTMLElement): void {
  const nameEl = item.querySelector(".excalihub-page-name") as HTMLElement;
  if (!nameEl) return;

  const input = document.createElement("input");
  input.className = "excalihub-page-rename";
  input.value = nameEl.textContent ?? "";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      // En série avec la synchro, qui modifie aussi la liste des pages
      await runExclusive(() => renamePage(item.dataset.id!, input.value));
      syncNow(); // fichier de sauvegarde renommé
    }
    await renderPages();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // ne pas déclencher les raccourcis d'Excalidraw
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function initPagesList(): void {
  const list = document.getElementById("excalihub-pages-list")!;

  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    const item = target.closest(".excalihub-page-item") as HTMLElement | null;
    if (!item) return;
    const action = (target.closest("[data-action]") as HTMLElement | null)?.dataset.action;
    const id = item.dataset.id!;

    if (action === "rename") {
      startRename(item);
    } else if (action === "delete") {
      const name = item.querySelector(".excalihub-page-name")?.textContent ?? "";
      if (confirm(`Delete “${name}”? Its content will be lost permanently.`)) {
        runPageOperation(() => deletePage(id));
      }
    } else if (!item.classList.contains("active")) {
      runPageOperation(() => switchToPage(id));
    }
  });

  list.addEventListener("dblclick", (e) => {
    const item = (e.target as HTMLElement).closest(".excalihub-page-item") as HTMLElement | null;
    if (item && (e.target as HTMLElement).closest(".excalihub-page-name")) startRename(item);
  });

  document.getElementById("excalihub-page-new")!.addEventListener("click", () => {
    runPageOperation(createPage);
  });
}

// ── Onglet Présentation : slides de toutes les pages, sections, aperçus ─
let slides: Slide[] = [];
let presPollingTimer: ReturnType<typeof setInterval> | null = null;
let thumbnails = new Map<string, HTMLCanvasElement>(); // id du frame → aperçu
let thumbsVersion = -1; // version de la page affichée lors de ses aperçus
let capturing = false;
let collapsed = new Set<string>();
let currentPageKey = ""; // frames de la page affichée, pour voir les changements
let dragIndex: number | null = null;

const currentPageSlides = () => slides.filter((s) => s.isCurrentPage);

function pageFramesKey(): string {
  return JSON.stringify(getFramesFromScene().map((f) => [f.id, f.name, f.order, f.section, f.width, f.height]));
}

async function reloadSlides(): Promise<void> {
  slides = await loadSlides();
  currentPageKey = pageFramesKey();
  const missing = slides.filter((s) => !thumbnails.has(s.id)).map((s) => s.id);
  if (missing.length) {
    for (const [id, canvas] of await loadStoredThumbnails(missing)) thumbnails.set(id, canvas);
  }
  updatePresSubtitle();
  rebuildSlideItems();
  updateStaleIndicator();
}

async function openSlidesTab(): Promise<void> {
  collapsed = await loadCollapsed();
  await reloadSlides();
  startPresPolling();
  ensureThumbnails();
}

function thumbnailsStale(): boolean {
  const current = currentPageSlides();
  return current.length > 0 && (thumbsVersion !== getSceneVersion() || current.some((s) => !thumbnails.has(s.id)));
}

function ensureThumbnails(): void {
  if (thumbnailsStale()) refreshThumbnails();
}

// Aperçus de la page affichée ; ceux des autres pages viennent de leur
// dernier affichage (conservés dans le stockage de l'extension)
async function refreshThumbnails(): Promise<void> {
  const current = currentPageSlides();
  if (capturing || current.length === 0) return;
  capturing = true;
  const refreshBtn = document.getElementById("excalihub-thumbs-refresh");
  refreshBtn?.classList.add("spinning");
  try {
    const version = getSceneVersion();
    const captured = await captureThumbnails(current);
    for (const [id, canvas] of captured) thumbnails.set(id, canvas);
    thumbsVersion = version;
    storeThumbnails(captured, new Set(slides.map((s) => s.id))).catch(() => {});
  } catch {
    // Excalidraw inaccessible : les slides restent sans aperçu
  } finally {
    capturing = false;
    refreshBtn?.classList.remove("spinning");
    rebuildSlideItems();
    updateStaleIndicator();
  }
}

function updateStaleIndicator(): void {
  document.getElementById("excalihub-thumbs-refresh")?.classList.toggle("stale", thumbnailsStale());
}

// La page affichée a changé (frame ajouté, renommé, page changée…) : on relit tout
function watchCurrentPage(): void {
  if (capturing || dragIndex !== null || document.querySelector(".excalihub-section-rename")) return;
  if (pageFramesKey() !== currentPageKey) reloadSlides();
  else updateStaleIndicator();
}

function updatePresSubtitle(): void {
  const count = document.getElementById("excalihub-slides-count");
  if (count) count.textContent = `Slides (${slides.length})`;
  const startBtn = document.getElementById("excalihub-pres-start") as HTMLButtonElement | null;
  if (startBtn) startBtn.disabled = slides.length === 0;
}

function startPresPolling(): void {
  stopPresPolling();
  presPollingTimer = setInterval(watchCurrentPage, 1500);
}

function stopPresPolling(): void {
  if (presPollingTimer !== null) {
    clearInterval(presPollingTimer);
    presPollingTimer = null;
  }
}

const ICON_CHEVRON = `<polyline points="6 9 12 15 18 9"/>`;
const ICON_SECTION = `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>`;

function buildSlideItemEl(slide: Slide, index: number, filter: string, showPage: boolean): HTMLElement {
  const item = document.createElement("div");
  item.className = `excalihub-pres-slide-item${slide.isCurrentPage ? "" : " other-page"}`;
  item.draggable = true;
  item.dataset.index = String(index);
  item.title = "Drag to reorder · Double-click to present from here";
  item.innerHTML = `
    <span class="excalihub-pres-slide-number">${index + 1}</span>
    <div class="excalihub-pres-slide-body">
      <div class="excalihub-pres-thumb"></div>
      <span class="excalihub-pres-slide-name">${escapeHtml(slide.name)}${
        showPage ? `<span class="excalihub-slide-page">${escapeHtml(slide.pageName)}</span>` : ""
      }</span>
    </div>
    <button class="excalihub-icon-btn excalihub-slide-add-section" data-action="add-section"
      title="New section starting at this slide">${svg(ICON_SECTION)}</button>
  `;

  const box = item.querySelector(".excalihub-pres-thumb") as HTMLElement;
  const cached = thumbnails.get(slide.id);
  if (cached) {
    // Un canvas ne peut être affiché qu'à un endroit : on recopie l'aperçu
    const copy = document.createElement("canvas");
    copy.width = cached.width;
    copy.height = cached.height;
    copy.getContext("2d")?.drawImage(cached, 0, 0);
    copy.style.filter = filter;
    box.appendChild(copy);
  } else {
    box.classList.add("empty");
    box.textContent = !slide.isCurrentPage
      ? "Preview available next time this page is opened"
      : capturing
        ? "…"
        : "Preview unavailable";
  }
  return item;
}

function buildSectionHeader(group: SectionGroup): HTMLElement {
  const section = group.section!;
  const header = document.createElement("div");
  const isCollapsed = collapsed.has(section.id);
  header.className = `excalihub-section${isCollapsed ? " collapsed" : ""}`;
  header.dataset.section = section.id;
  header.dataset.start = String(group.start);
  header.title = "Click: collapse / expand · Double-click the name: rename";
  header.innerHTML = `
    <span class="excalihub-section-toggle">${svg(ICON_CHEVRON)}</span>
    <span class="excalihub-section-name">${escapeHtml(section.name)}</span>
    <span class="excalihub-section-count">(${group.slides.length})</span>
    <span class="excalihub-section-actions">
      <button class="excalihub-icon-btn" data-action="rename-section" title="Rename section">${svg(ICON_EDIT)}</button>
      <button class="excalihub-icon-btn danger" data-action="delete-section"
        title="Remove section (slides are kept)">${svg(ICON_TRASH)}</button>
    </span>
  `;
  return header;
}

function rebuildSlideItems(): void {
  const container = document.getElementById("excalihub-pres-slides");
  if (!container) return;

  if (slides.length === 0) {
    container.innerHTML = `
      <div class="excalihub-pres-empty">
        <p>No frames in your pages.</p>
        <p>Add frames to create slides.<br/>Tip: press F or use the Frame tool.</p>
      </div>
    `;
    return;
  }

  const filter = canvasFilter();
  const showPage = new Set(slides.map((s) => s.pageId)).size > 1;
  const children: HTMLElement[] = [];
  for (const group of groupBySection(slides)) {
    if (group.section) children.push(buildSectionHeader(group));
    if (group.section && collapsed.has(group.section.id)) continue;
    group.slides.forEach((slide, i) => children.push(buildSlideItemEl(slide, group.start + i, filter, showPage)));
  }
  container.replaceChildren(...children);
}

// Modification de l'ordre ou des sections : affichage immédiat, puis
// enregistrement dans les pages (sans périmer les aperçus)
async function commitSlides(next: Slide[]): Promise<void> {
  slides = withEffectiveSections(next);
  updatePresSubtitle();
  rebuildSlideItems();
  const wasFresh = !thumbnailsStale();
  await saveDeck(slides).catch((err) => showToast(`Order not saved: ${(err as Error).message}`));
  setTimeout(() => {
    if (wasFresh) thumbsVersion = getSceneVersion();
    currentPageKey = pageFramesKey();
    updateStaleIndicator();
  }, 1200);
}

// « Nouvelle section » sur une slide : elle et les suivantes de sa section
// passent dans la nouvelle ; les slides d'avant forment la « Section par défaut »
function addSectionAt(index: number): void {
  const section = { id: crypto.randomUUID().slice(0, 8), name: "New section" };
  const next = withEffectiveSections(slides).map((s) => ({ ...s }));
  const from = next[index].section?.id ?? null;
  for (let i = index; i < next.length && (next[i].section?.id ?? null) === from; i++) next[i].section = section;
  for (let i = 0; i < index; i++) next[i].section ??= DEFAULT_SECTION;
  commitSlides(next).then(() => startSectionRename(section.id));
}

// Suppression d'une section : ses slides rejoignent la section précédente
// (ou la suivante) ; sans autre section, la liste redevient à plat
function deleteSection(sectionId: string): void {
  const indices = slides.flatMap((s, i) => (s.section?.id === sectionId ? [i] : []));
  if (!indices.length) return;
  const before = indices[0] > 0 ? slides[indices[0] - 1].section : null;
  const after = slides[indices[indices.length - 1] + 1]?.section ?? null;
  const next = slides.map((s) => ({ ...s }));
  for (const i of indices) next[i].section = before ?? after;
  if (new Set(next.map((s) => s.section?.id ?? null)).size <= 1) next.forEach((s) => (s.section = null));
  collapsed.delete(sectionId);
  saveCollapsed(collapsed).catch(() => {});
  commitSlides(next);
}

function renameSection(sectionId: string, name: string): void {
  commitSlides(
    slides.map((s) => (s.section?.id === sectionId ? { ...s, section: { id: sectionId, name: name.trim() } } : s)),
  );
}

function startSectionRename(sectionId: string): void {
  const header = document.querySelector<HTMLElement>(`.excalihub-section[data-section="${sectionId}"]`);
  const nameEl = header?.querySelector(".excalihub-section-name") as HTMLElement | null;
  if (!header || !nameEl) return;
  const input = document.createElement("input");
  input.className = "excalihub-section-rename";
  input.value = nameEl.textContent ?? "";
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== nameEl.textContent) renameSection(sectionId, input.value);
    else rebuildSlideItems();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // pas de raccourcis Excalidraw
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function toggleSection(sectionId: string): void {
  if (collapsed.has(sectionId)) collapsed.delete(sectionId);
  else collapsed.add(sectionId);
  saveCollapsed(collapsed).catch(() => {});
  rebuildSlideItems();
}

// Déplacement : la slide prend la place visée et adopte la section de cet endroit
function moveSlide(from: number, to: number, section: Slide["section"]): void {
  const next = slides.map((s) => ({ ...s }));
  const [moved] = next.splice(from, 1);
  moved.section = section;
  next.splice(Math.min(to, next.length), 0, moved);
  commitSlides(next);
}

function initSlideList(): void {
  const container = document.getElementById("excalihub-pres-slides")!;
  const clearMarks = () => container.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  container.addEventListener("dragstart", (e) => {
    const item = (e.target as HTMLElement).closest(".excalihub-pres-slide-item") as HTMLElement;
    if (!item) return;
    dragIndex = Number(item.dataset.index);
    item.classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
  });

  container.addEventListener("dragend", (e) => {
    (e.target as HTMLElement).closest(".excalihub-pres-slide-item")?.classList.remove("dragging");
    clearMarks();
    dragIndex = null;
  });

  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const target = (e.target as HTMLElement).closest(".excalihub-pres-slide-item, .excalihub-section") as HTMLElement;
    if (!target || Number(target.dataset.index) === dragIndex) return;
    clearMarks();
    target.classList.add("drag-over");
  });

  container.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = dragIndex;
    if (from === null) return;
    const item = (e.target as HTMLElement).closest(".excalihub-pres-slide-item") as HTMLElement | null;
    const header = (e.target as HTMLElement).closest(".excalihub-section") as HTMLElement | null;
    if (item) {
      const to = Number(item.dataset.index);
      if (to !== from) moveSlide(from, to, slides[to].section);
    } else if (header) {
      // Sur un titre de section : en tête de cette section
      const start = Number(header.dataset.start);
      moveSlide(from, from < start ? start - 1 : start, slides[start].section);
    }
  });

  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    const action = (target.closest("[data-action]") as HTMLElement | null)?.dataset.action;
    const header = target.closest(".excalihub-section") as HTMLElement | null;
    if (action === "add-section") {
      addSectionAt(Number((target.closest(".excalihub-pres-slide-item") as HTMLElement).dataset.index));
    } else if (header && action === "rename-section") {
      startSectionRename(header.dataset.section!);
    } else if (header && action === "delete-section") {
      deleteSection(header.dataset.section!);
    } else if (header) {
      // Clic sur le titre : réduire / développer (différé pour laisser place au double-clic)
      const id = header.dataset.section!;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => toggleSection(id), 250);
    }
  });

  container.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    const header = target.closest(".excalihub-section") as HTMLElement | null;
    if (header) {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = null;
      if (target.closest(".excalihub-section-name")) startSectionRename(header.dataset.section!);
      return;
    }
    const item = target.closest(".excalihub-pres-slide-item") as HTMLElement | null;
    if (item && !target.closest("[data-action]")) startPresentation(Number(item.dataset.index));
  });
}

// Ouvre la page d'une slide (diaporama sur plusieurs pages)
async function ensurePage(pageId: string): Promise<boolean> {
  const index = await getPagesIndex();
  if (index.currentId === pageId || !index.pages.some((p) => p.id === pageId)) return false;
  await runExclusive(() => switchToPage(pageId));
  return true;
}

async function startPresentation(startIndex = 0): Promise<void> {
  if (capturing || slides.length === 0) return;
  const index = await getPagesIndex();
  closePanel();
  enterPresentationMode(
    slides.map((s) => ({ ...s })),
    readTransitionInputs(),
    startIndex,
    { ensurePage, originalPageId: index.currentId },
  );
}

// ── Construction du panneau ───────────────────────────────────────────
function createPanel(): void {
  const toggle = document.createElement("button");
  toggle.id = "excalihub-toggle";
  toggle.textContent = "Excalihub";
  document.body.appendChild(toggle);

  const transitionOptions = TRANSITIONS.map(
    (t) => `<option value="${t.type}">${escapeHtml(t.label)}</option>`,
  ).join("");

  const panel = document.createElement("div");
  panel.id = "excalihub-panel";
  panel.innerHTML = `
    <div class="excalihub-tabs">
      <button class="excalihub-tab" data-tab="pages">Pages</button>
      <button class="excalihub-tab" data-tab="slides">Slides</button>
      <button class="excalihub-tab" data-tab="latex">Formulas</button>
      <button class="excalihub-icon-btn excalihub-close" id="excalihub-close" title="Close (Ctrl+X)">${svg(ICON_CLOSE)}</button>
    </div>

    <div class="excalihub-tab-view" data-view="latex" hidden>
      <div class="excalihub-latex-help">
        <label class="excalihub-latex-toggle">
          <input type="checkbox" id="excalihub-latex-enabled" />
          <span>Render LaTeX formulas</span>
        </label>
        <p>Write LaTeX in an Excalidraw text (Text tool, key T):</p>
        <ul>
          <li><code>$…$</code>: inline formula</li>
          <li><code>$$…$$</code>: formula on its own line</li>
          <li><code>\\$</code>: a literal dollar sign</li>
        </ul>
        <p>As soon as you leave the text, it is rendered in place, at the same size.
          <strong>Double-click a formula</strong> (or select it and press Enter) to get its code back
          and edit it.</p>
        <p class="excalihub-latex-title">Examples</p>
        <pre>$P = \\sqrt{3}\\,U\\,I\\cos\\varphi$</pre>
        <pre>Current: $I = \\dfrac{S}{\\sqrt{3}\\,U}$</pre>
        <pre>$$\\Delta U = \\frac{\\sqrt{3}\\,I\\,L\\,(R\\cos\\varphi + X\\sin\\varphi)}{U}$$</pre>
      </div>
    </div>

    <div class="excalihub-tab-view" data-view="pages" hidden>
      <div class="excalihub-backup" id="excalihub-backup"></div>
      <div class="excalihub-pages-list" id="excalihub-pages-list"></div>
      <div class="excalihub-pres-footer">
        <button class="excalihub-btn primary excalihub-pres-start-btn" id="excalihub-page-new">
          ${svg(ICON_PLUS)} New page
        </button>
      </div>
    </div>

    <div class="excalihub-tab-view" data-view="slides" hidden>
      <div class="excalihub-pres-subtitle">
        <span id="excalihub-slides-count">Slides (0)</span>
        <button class="excalihub-icon-btn" id="excalihub-thumbs-refresh" title="Refresh previews">
          ${svg(ICON_REFRESH)}
        </button>
      </div>
      <div class="excalihub-pres-slides" id="excalihub-pres-slides"></div>
      <div class="excalihub-pres-footer">
        <div class="excalihub-pres-settings">
          <label class="excalihub-pres-setting">
            <span>Transition</span>
            <select id="excalihub-pres-transition">${transitionOptions}</select>
          </label>
          <label class="excalihub-pres-setting">
            <span>Duration</span>
            <select id="excalihub-pres-duration">
              <option value="300">Fast</option>
              <option value="600">Medium</option>
              <option value="1000">Slow</option>
            </select>
          </label>
        </div>
        <button class="excalihub-btn primary excalihub-pres-start-btn" id="excalihub-pres-start" disabled>
          ${svg(ICON_PLAY, 16)} Start slideshow
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  toggle.addEventListener("click", togglePanel);
  panel.querySelector("#excalihub-close")!.addEventListener("click", closePanel);

  // Ctrl+X (signalé par le bridge, voir bridge.ts) ; Échap ferme le panneau quand on est dedans
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !isPanelOpen()) return;
      if (!panel.contains(document.activeElement) && !panel.matches(":hover")) return;
      if ((e.target as HTMLElement).closest?.("input")) return; // Échap annule d'abord une saisie
      closePanel();
    },
    true,
  );
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "excalihub:toggle-panel") togglePanel();
  });

  panel.querySelectorAll<HTMLElement>(".excalihub-tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab as Tab));
  });

  const transitionSelect = document.getElementById("excalihub-pres-transition") as HTMLSelectElement;
  const durationSelect = document.getElementById("excalihub-pres-duration") as HTMLSelectElement;
  const initial = loadTransition();
  transitionSelect.value = initial.type;
  durationSelect.value = String(initial.duration);
  durationSelect.disabled = initial.type === "none";

  const onTransitionChange = () => {
    const t = readTransitionInputs();
    durationSelect.disabled = t.type === "none";
    saveTransition(t);
  };
  transitionSelect.addEventListener("change", onTransitionChange);
  durationSelect.addEventListener("change", onTransitionChange);

  const latexToggle = document.getElementById("excalihub-latex-enabled") as HTMLInputElement;
  latexToggle.checked = latexEnabled();
  latexToggle.addEventListener("change", () => setLatexEnabled(latexToggle.checked));

  document.getElementById("excalihub-thumbs-refresh")!.addEventListener("click", () => refreshThumbnails());
  document.getElementById("excalihub-pres-start")!.addEventListener("click", () => startPresentation(0));

  initPagesList();
  initSlideList();
  initBackupBox();
  applyTheme();
  observeTheme();
}

// ── Extension rechargée pendant que la page est ouverte ──────────────
// Chrome coupe alors ce script de l'extension (« Extension context
// invalidated ») : on s'arrête proprement et on invite à recharger la page.
function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const isInvalidated = (reason: unknown) =>
  /Extension context invalidated/i.test(String((reason as { message?: string })?.message ?? reason));

window.addEventListener("unhandledrejection", (e) => {
  if (isInvalidated(e.reason)) e.preventDefault();
});

const aliveWatch = setInterval(() => {
  if (extensionAlive()) return;
  clearInterval(aliveWatch);
  stopBackup();
  stopPresPolling();
  document.getElementById("excalihub-panel")?.remove();
  document.getElementById("excalihub-toggle")?.remove();
  showToast("Excalihub was updated: reload the page (F5) to turn it back on.");
}, 1000);

createPanel();
startBackup();
