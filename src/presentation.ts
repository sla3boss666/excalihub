// Mode diaporama : chaque frame est une slide affichée seule, plein écran,
// avec des transitions inspirées de PowerPoint.
import { callBridge, waitForRender } from "./bridgeClient";
import { canvasFilter, captureRect, displayedColor, themeColorFilter } from "./capture";
import { fitFrame, getFramesFromScene, PresentationFrame, ScreenRect, SLIDE_FRAME_RENDERING } from "./frames";

export type TransitionType = "none" | "fade" | "push" | "reveal";

// Transitions PowerPoint utilisées au quotidien
export const TRANSITIONS: { type: TransitionType; label: string }[] = [
  { type: "none", label: "None" },
  { type: "fade", label: "Fade" },
  { type: "push", label: "Push (up)" },
  { type: "reveal", label: "Reveal" },
];

export interface TransitionOptions {
  type: TransitionType;
  duration: number; // ms
}

export const DEFAULT_TRANSITION: TransitionOptions = { type: "fade", duration: 600 };

const EASING = "cubic-bezier(0.65, 0, 0.35, 1)";
const IDLE_DELAY = 2500; // ms avant de masquer barre d'outils et curseur
const BACKGROUND_VAR = "--excalihub-pres-bg"; // couleur des bandes et du fond des transitions

interface AppState {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  frameRendering: { enabled: boolean; name: boolean; outline: boolean; clip: boolean };
  viewModeEnabled: boolean;
  theme: string;
  viewBackgroundColor: string;
}

// Diaporama sur plusieurs pages : ouverture de la page d'une slide
export interface PageNavigation {
  ensurePage(pageId: string): Promise<boolean>; // true si la page a changé
  originalPageId: string;
}

interface PresentationState {
  pages: PageNavigation | null;
  frames: PresentationFrame[];
  currentIndex: number;
  currentRect: ScreenRect;
  transition: TransitionOptions;
  originalAppState: AppState;
  overlay: HTMLElement; // barre d'outils + capture des clics
  mask: HTMLElement; // bandes autour de la slide, couleur du fond de la page
  stage: HTMLElement; // calques animés pendant une transition
  screen: HTMLElement; // écran noir/blanc (B / W) et fin du diaporama
  screenMode: "none" | "black" | "white" | "end";
  animations: Animation[];
  navToken: number;
  lastWheel: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  leavingFullscreen: boolean;
  keydownHandler: (e: KeyboardEvent) => void;
  resizeHandler: () => void;
  fullscreenHandler: () => void;
}

let state: PresentationState | null = null;

// ── Éléments d'interface ──────────────────────────────────────────────
const ICONS = {
  prev: `<polyline points="15 18 9 12 15 6"></polyline>`,
  next: `<polyline points="9 18 15 12 9 6"></polyline>`,
  theme: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>`,
  fullscreen: `<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>`,
  exit: `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`,
};

function icon(paths: string): string {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function createOverlay(totalSlides: number): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "excalihub-presentation";
  overlay.innerHTML = `
    <div class="pres-toolbar">
      <button class="pres-btn" id="pres-prev" title="Previous slide (←)">${icon(ICONS.prev)}</button>
      <span class="pres-counter" id="pres-counter">1 / ${totalSlides}</span>
      <button class="pres-btn" id="pres-next" title="Next slide (→)">${icon(ICONS.next)}</button>
      <div class="pres-divider"></div>
      <button class="pres-btn" id="pres-theme" title="Light / dark theme (T)">${icon(ICONS.theme)}</button>
      <button class="pres-btn" id="pres-download" title="Download slide (D)">${icon(ICONS.download)}</button>
      <button class="pres-btn" id="pres-fullscreen" title="Full screen (F)">${icon(ICONS.fullscreen)}</button>
      <div class="pres-divider"></div>
      <button class="pres-btn" id="pres-exit" title="Exit (Esc)">${icon(ICONS.exit)}</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const toolbar = overlay.querySelector(".pres-toolbar")!;
  overlay.querySelector("#pres-prev")!.addEventListener("click", previous);
  overlay.querySelector("#pres-next")!.addEventListener("click", next);
  overlay.querySelector("#pres-theme")!.addEventListener("click", toggleTheme);
  overlay.querySelector("#pres-download")!.addEventListener("click", downloadSlide);
  overlay.querySelector("#pres-fullscreen")!.addEventListener("click", toggleFullscreen);
  overlay.querySelector("#pres-exit")!.addEventListener("click", () => exitPresentationMode());

  // Comme PowerPoint : clic = suivante, clic droit = précédente, molette = navigation.
  // L'overlay intercepte aussi les gestes qui feraient bouger le canevas.
  overlay.addEventListener("click", (e) => {
    if (!toolbar.contains(e.target as Node)) next();
  });
  overlay.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!toolbar.contains(e.target as Node)) previous();
  });
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!state || Math.abs(e.deltaY) < 4) return;
      const now = performance.now();
      if (now - state.lastWheel < state.transition.duration + 150) return;
      state.lastWheel = now;
      if (e.deltaY > 0) next();
      else previous();
    },
    { passive: false },
  );
  overlay.addEventListener("mousemove", wakeUp);

  return overlay;
}

function createLayer(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  document.body.appendChild(el);
  return el;
}

// Barre d'outils et curseur disparaissent après quelques secondes d'inactivité
function wakeUp(): void {
  if (!state) return;
  state.overlay.classList.remove("pres-idle");
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => state?.overlay.classList.add("pres-idle"), IDLE_DELAY);
}

// Bandes et fond des transitions = fond du dessin, tel qu'affiché
// (le thème sombre d'Excalidraw inverse les couleurs du canevas).
async function applyBackground(): Promise<void> {
  const appState = await callBridge<AppState>("getAppState");
  if (!state) return;
  setBackground(appState);
}

function setBackground(appState: AppState): void {
  const color = displayedColor(appState.viewBackgroundColor, themeColorFilter(appState.theme));
  document.body.style.setProperty(BACKGROUND_VAR, color);
}

function setMask(rect: ScreenRect): void {
  if (!state) return;
  const m = state.mask.style;
  m.left = `${rect.left}px`;
  m.top = `${rect.top}px`;
  m.width = `${rect.width}px`;
  m.height = `${rect.height}px`;
}

function updateToolbar(): void {
  if (!state) return;
  const counter = state.overlay.querySelector("#pres-counter");
  if (counter) counter.textContent = `${state.currentIndex + 1} / ${state.frames.length}`;
  (state.overlay.querySelector("#pres-prev") as HTMLButtonElement).disabled = state.currentIndex === 0;
}

// ── Écrans spéciaux : noir (B), blanc (W), fin du diaporama ──────────
function setScreen(mode: PresentationState["screenMode"]): void {
  if (!state) return;
  state.screenMode = mode;
  const s = state.screen;
  s.className = `excalihub-pres-screen${mode === "none" ? "" : ` show ${mode}`}`;
  s.textContent = mode === "end" ? "End of slideshow. Click to exit." : "";
}

// ── Navigation ────────────────────────────────────────────────────────
function next(): void {
  if (!state) return;
  if (state.screenMode === "end") {
    exitPresentationMode();
  } else if (state.screenMode !== "none") {
    setScreen("none");
  } else if (state.currentIndex >= state.frames.length - 1) {
    finishTransition();
    setScreen("end");
  } else {
    navigateToSlide(state.currentIndex + 1);
  }
}

function previous(): void {
  if (!state) return;
  if (state.screenMode !== "none") setScreen("none");
  else navigateToSlide(state.currentIndex - 1);
}

function finishTransition(): void {
  if (!state) return;
  state.animations.forEach((a) => a.cancel());
  state.animations = [];
  state.stage.replaceChildren();
  state.stage.classList.remove("active");
}

async function navigateToSlide(index: number, animate = true): Promise<void> {
  if (!state || index < 0 || index >= state.frames.length) return;

  finishTransition();
  const token = ++state.navToken;
  const forward = index >= state.currentIndex;
  const fromRect = state.currentRect;
  const view = fitFrame(state.frames[index]);

  state.currentIndex = index;
  state.currentRect = view.rect;
  updateToolbar();

  const slide = state.frames[index];
  const pages = state.pages;
  const jump = async () => {
    // Slide d'une autre page : on ouvre d'abord cette page (son fond peut différer)
    if (pages && slide.pageId && (await pages.ensurePage(slide.pageId))) await applyBackground();
    await callBridge("updateScene", {
      appState: {
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: { value: view.zoom },
        frameRendering: SLIDE_FRAME_RENDERING,
      },
    });
  };

  const { type, duration } = state.transition;

  if (!animate || type === "none" || duration <= 0) {
    setMask(view.rect);
    await jump();
    return;
  }

  // Transitions « à la PowerPoint » : on fige l'ancienne slide (A), on passe
  // à la nouvelle dessous, on la fige aussi (B), puis on anime A et B.
  const before = captureRect(fromRect);
  if (!before) {
    setMask(view.rect);
    await jump();
    return;
  }

  const filter = canvasFilter();
  const layerA = makeSlideLayer(before, fromRect, filter);
  state.stage.replaceChildren(layerA);
  state.stage.classList.add("active");

  setMask(view.rect);
  await jump();
  await waitForRender();
  if (!state || token !== state.navToken) return;

  const after = captureRect(view.rect);
  const layerB = after ? makeSlideLayer(after, view.rect, filter) : null;
  await runTransition(type, layerA, layerB, duration, forward, token);
}

// Calque plein écran, fond de la page, slide positionnée comme à l'écran
function makeSlideLayer(slide: HTMLCanvasElement, rect: ScreenRect, filter: string): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "excalihub-pres-layer";
  Object.assign(slide.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    filter,
  });
  layer.appendChild(slide);
  return layer;
}

async function runTransition(
  type: TransitionType,
  a: HTMLElement,
  b: HTMLElement | null,
  duration: number,
  forward: boolean,
  token: number,
): Promise<void> {
  if (!state) return;
  const stage = state.stage;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // En arrière (slide précédente), le mouvement est inversé
  const dir = forward ? 1 : -1;
  const timing: KeyframeAnimationOptions = { duration, easing: EASING, fill: "forwards" };
  const anims: Animation[] = [];

  if (!b) {
    // Nouvelle slide non capturée : simple fondu vers le canevas réel
    stage.classList.remove("active");
    anims.push(a.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, easing: "ease-in-out" }));
  } else {
    switch (type) {
      case "fade":
        // L'ancienne slide s'efface au-dessus de la nouvelle
        stage.replaceChildren(b, a);
        anims.push(a.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, easing: "ease-in-out" }));
        break;
      case "push":
        // La nouvelle slide arrive du bas et pousse l'ancienne vers le haut
        stage.replaceChildren(a, b);
        anims.push(
          a.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-dir * h}px)` }], timing),
          b.animate([{ transform: `translateY(${dir * h}px)` }, { transform: "translateY(0)" }], timing),
        );
        break;
      case "reveal": {
        // L'ancienne slide glisse vers la gauche en s'effaçant, la nouvelle
        // apparaît en fondu en glissant depuis la droite (« Smoothly from right »)
        const shift = 0.25 * w * dir;
        stage.replaceChildren(a, b);
        anims.push(
          a.animate(
            [
              { transform: "translateX(0)", opacity: 1 },
              { transform: `translateX(${-shift}px)`, opacity: 0, offset: 0.6 },
              { transform: `translateX(${-shift}px)`, opacity: 0 },
            ],
            { ...timing, easing: "ease-in-out" },
          ),
          b.animate(
            [
              { transform: `translateX(${shift}px)`, opacity: 0 },
              { transform: `translateX(${shift}px)`, opacity: 0, offset: 0.35 },
              { transform: "translateX(0)", opacity: 1 },
            ],
            { ...timing, easing: "ease-in-out" },
          ),
        );
        break;
      }
      default:
        stage.replaceChildren(b);
    }
  }

  state.animations = anims;
  try {
    await Promise.all(anims.map((anim) => anim.finished));
  } catch {
    return; // animation annulée par une navigation plus récente
  }
  if (state && token === state.navToken) finishTransition();
}

// ── Actions ───────────────────────────────────────────────────────────
async function toggleTheme(): Promise<void> {
  if (!state) return;
  const appState = await callBridge<AppState>("getAppState");
  const nextTheme = appState.theme === "dark" ? "light" : "dark";
  await callBridge("updateScene", { appState: { theme: nextTheme } });
  if (!state) return;
  state.overlay.classList.toggle("pres-dark", nextTheme === "dark");
  // Le filtre du thème est appliqué au rendu suivant : on recalcule ensuite
  await waitForRender(2);
  await applyBackground();
}

function toggleFullscreen(): void {
  if (!state) return;
  if (document.fullscreenElement) {
    state.leavingFullscreen = true;
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function downloadSlide(): void {
  if (!state) return;
  const slide = captureRect(state.currentRect);
  if (!slide) return;
  const index = state.currentIndex;
  try {
    slide.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.download = `slide-${index + 1}.png`;
      link.href = URL.createObjectURL(blob);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, "image/png");
  } catch {
    alert("Could not export the slide: it contains images from another origin.");
  }
}

// ── Entrée / sortie ───────────────────────────────────────────────────
export async function enterPresentationMode(
  orderedFrames?: PresentationFrame[],
  transition: TransitionOptions = DEFAULT_TRANSITION,
  startIndex = 0,
  pages: PageNavigation | null = null,
): Promise<void> {
  if (state) return;

  // Plein écran d'emblée, comme un diaporama PowerPoint (doit suivre le clic)
  const fullscreen = document.documentElement.requestFullscreen().catch(() => {});

  let apiAvailable: boolean;
  try {
    apiAvailable = await callBridge<boolean>("ping");
  } catch {
    apiAvailable = false;
  }

  const frames = orderedFrames ?? getFramesFromScene();
  if (!apiAvailable || frames.length === 0) {
    await fullscreen;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    alert(
      !apiAvailable
        ? "Could not reach Excalidraw. Reload the page."
        : "No frames on the canvas.\n\nAdd frames to create slides.\nTip: press F or use the Frame tool.",
    );
    return;
  }

  await fullscreen;
  const originalAppState = await callBridge<AppState>("getAppState");
  // Couleur des bandes fixée avant d'afficher quoi que ce soit (pas de flash)
  setBackground(originalAppState);
  await callBridge("updateScene", {
    appState: { viewModeEnabled: true, frameRendering: SLIDE_FRAME_RENDERING },
  });

  const mask = createLayer("excalihub-pres-mask");
  const stage = createLayer("excalihub-pres-stage");
  const screen = createLayer("excalihub-pres-screen");
  const overlay = createOverlay(frames.length);
  document.body.classList.add("excalihub-presenting");
  if (originalAppState.theme === "dark") overlay.classList.add("pres-dark");

  const keydownHandler = (e: KeyboardEvent) => {
    if (!state) return;
    // Rien ne doit atteindre Excalidraw pendant le diaporama
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const actions: Record<string, () => void> = {
      ArrowRight: next,
      ArrowDown: next,
      PageDown: next,
      " ": next,
      Enter: next,
      n: next,
      N: next,
      ArrowLeft: previous,
      ArrowUp: previous,
      PageUp: previous,
      Backspace: previous,
      p: previous,
      P: previous,
      Home: () => (setScreen("none"), navigateToSlide(0)),
      End: () => (setScreen("none"), navigateToSlide(state!.frames.length - 1)),
      Escape: () => exitPresentationMode(),
      f: toggleFullscreen,
      F: toggleFullscreen,
      t: toggleTheme,
      T: toggleTheme,
      d: downloadSlide,
      D: downloadSlide,
      b: () => setScreen(state!.screenMode === "black" ? "none" : "black"),
      B: () => setScreen(state!.screenMode === "black" ? "none" : "black"),
      w: () => setScreen(state!.screenMode === "white" ? "none" : "white"),
      W: () => setScreen(state!.screenMode === "white" ? "none" : "white"),
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  const resizeHandler = () => {
    if (state) navigateToSlide(state.currentIndex, false);
  };

  // Échap en plein écran est capté par le navigateur : sortir du plein écran
  // (autrement que par F) termine le diaporama, comme dans PowerPoint.
  const fullscreenHandler = () => {
    if (!state || document.fullscreenElement) return;
    if (state.leavingFullscreen) state.leavingFullscreen = false;
    else exitPresentationMode();
  };

  document.addEventListener("keydown", keydownHandler, true);
  window.addEventListener("resize", resizeHandler);
  document.addEventListener("fullscreenchange", fullscreenHandler);

  const first = Math.min(Math.max(startIndex, 0), frames.length - 1);
  state = {
    pages,
    frames,
    currentIndex: first,
    currentRect: fitFrame(frames[first]).rect,
    transition,
    originalAppState,
    overlay,
    mask,
    stage,
    screen,
    screenMode: "none",
    animations: [],
    navToken: 0,
    lastWheel: 0,
    idleTimer: null,
    leavingFullscreen: false,
    keydownHandler,
    resizeHandler,
    fullscreenHandler,
  };

  await navigateToSlide(first, false);
  wakeUp();
}

export async function exitPresentationMode(): Promise<void> {
  if (!state) return;

  const saved = state;
  state = null;

  saved.animations.forEach((a) => a.cancel());
  if (saved.idleTimer) clearTimeout(saved.idleTimer);
  [saved.overlay, saved.mask, saved.stage, saved.screen].forEach((el) => el.remove());
  document.removeEventListener("keydown", saved.keydownHandler, true);
  window.removeEventListener("resize", saved.resizeHandler);
  document.removeEventListener("fullscreenchange", saved.fullscreenHandler);
  document.body.classList.remove("excalihub-presenting");
  document.body.style.removeProperty(BACKGROUND_VAR);

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  try {
    // Retour à la page de départ si le diaporama en a ouvert d'autres
    if (saved.pages) await saved.pages.ensurePage(saved.pages.originalPageId);
    await callBridge("updateScene", {
      appState: {
        scrollX: saved.originalAppState.scrollX,
        scrollY: saved.originalAppState.scrollY,
        zoom: saved.originalAppState.zoom,
        frameRendering: saved.originalAppState.frameRendering,
        viewModeEnabled: saved.originalAppState.viewModeEnabled,
        theme: saved.originalAppState.theme,
      },
    });
  } catch {
    // Restauration au mieux
  }
}
