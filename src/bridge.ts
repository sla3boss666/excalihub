interface ExcalidrawAPI {
  updateScene: (scene: unknown) => void;
  getAppState: () => Record<string, any>;
  getSceneElements?: () => readonly Record<string, any>[];
  getSceneElementsIncludingDeleted?: () => readonly Record<string, any>[];
  onChange?: (callback: () => void) => () => void;
  getFiles?: () => Record<string, Record<string, any>>;
  addFiles?: (files: Record<string, any>[]) => void;
  history?: { clear?: () => void };
  isDestroyed?: boolean;
}

// Scène sérialisable échangée avec le content script (pages)
interface SceneData {
  elements: Record<string, any>[];
  appState: Record<string, any>;
  files: Record<string, Record<string, any>>;
}

interface BridgeMessage {
  source: string;
  id: string;
  method: string;
  args?: unknown[];
}

(function () {
  function isAPI(obj: unknown): obj is ExcalidrawAPI {
    return (
      obj != null &&
      typeof obj === "object" &&
      typeof (obj as ExcalidrawAPI).updateScene === "function" &&
      typeof (obj as ExcalidrawAPI).getAppState === "function"
    );
  }

  let cachedAPI: ExcalidrawAPI | null = null;

  function findAPI(): ExcalidrawAPI | null {
    if (cachedAPI && !cachedAPI.isDestroyed && isAPI(cachedAPI)) {
      return cachedAPI;
    }
    cachedAPI = null;

    const el = document.querySelector(".excalidraw");
    if (!el) return null;

    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;

    let fiber: any = (el as any)[fiberKey];
    const visited = new Set();

    while (fiber && !visited.has(fiber)) {
      visited.add(fiber);

      // Class component instance (App stores this.api)
      if (
        fiber.stateNode &&
        fiber.stateNode !== el &&
        !(fiber.stateNode instanceof HTMLElement)
      ) {
        if (isAPI(fiber.stateNode.api)) {
          cachedAPI = fiber.stateNode.api;
          return cachedAPI;
        }
      }

      // React hooks (useState / useRef)
      if (fiber.memoizedState) {
        let hook = fiber.memoizedState;
        while (hook) {
          const val = hook.memoizedState;
          if (isAPI(val)) { cachedAPI = val; return cachedAPI; }
          if (val && val.current && isAPI(val.current)) { cachedAPI = val.current; return cachedAPI; }
          if (hook.queue && isAPI(hook.queue.lastRenderedState)) {
            cachedAPI = hook.queue.lastRenderedState;
            return cachedAPI;
          }
          hook = hook.next;
        }
      }

      // Context provider
      if (fiber.memoizedProps && isAPI(fiber.memoizedProps.value)) {
        cachedAPI = fiber.memoizedProps.value;
        return cachedAPI;
      }

      fiber = fiber.return;
    }

    return null;
  }

  // ── Pages : lecture / chargement de la scène complète ────────────────
  function getScene(api: ExcalidrawAPI): SceneData {
    if (!api.getSceneElements || !api.getFiles) throw new Error("Incomplete Excalidraw API");
    const s = api.getAppState();
    // Copie JSON : les éléments d'Excalidraw sont figés et non clonables tels quels.
    // Jamais d'élément masqué par le diaporama dans ce qui est enregistré.
    const elements = cleanScene(JSON.parse(JSON.stringify(api.getSceneElements())));

    // On ne garde que les images réellement utilisées par la page
    const allFiles = api.getFiles();
    const files: SceneData["files"] = {};
    for (const el of elements) {
      if (el.fileId && allFiles[el.fileId]) files[el.fileId] = allFiles[el.fileId];
    }

    return {
      elements,
      appState: {
        viewBackgroundColor: s.viewBackgroundColor,
        scrollX: s.scrollX,
        scrollY: s.scrollY,
        zoom: { value: s.zoom.value },
      },
      files,
    };
  }

  function loadScene(api: ExcalidrawAPI, scene: SceneData): void {
    // Morph en cours (diaporama) : il réécrirait à chaque image les éléments
    // de la page quittée par-dessus la page chargée
    finishAnimation();
    const files = Object.values(scene.files ?? {});
    if (files.length && api.addFiles) api.addFiles(files);
    api.updateScene({
      elements: cleanScene(scene.elements ?? []),
      appState: {
        ...scene.appState,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      },
      // Page chargée = nouveau point de départ d'Excalidraw : la modification
      // suivante n'embarque pas la page quittée (que Ctrl+Z ferait revenir)
      captureUpdate: "NEVER",
      storeAction: "update",
      commitToHistory: false,
    });
    // Pas d'annulation (Ctrl+Z) qui ramènerait le contenu d'une autre page
    api.history?.clear?.();
  }

  // ── Formules LaTeX ────────────────────────────────────────────────────
  // Un texte contenant $…$ est remplacé, une fois sa saisie terminée, par
  // l'image de la formule (rendue par MathJax côté content script). Le texte
  // d'origine est gardé dans customData pour pouvoir le modifier ensuite.
  interface FormulaResult {
    id: string;
    version: number;
    dataURL: string;
    width: number;
    height: number;
  }

  const LATEX_SETTING_KEY = "excalihub-latex"; // "off" = conversion désactivée
  const latexSeen = new Map<string, number>(); // texte déjà examiné : id → version
  let watchedAPI: ExcalidrawAPI | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  function latexDisabled(): boolean {
    try {
      return localStorage.getItem(LATEX_SETTING_KEY) === "off";
    } catch {
      return false;
    }
  }

  function randomInt(): number {
    return Math.floor(Math.random() * 2 ** 31);
  }

  function randomId(length = 20): string {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  }

  function allElements(api: ExcalidrawAPI): Record<string, any>[] {
    return [...(api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements?.() ?? [])];
  }

  function deleted(el: Record<string, any>): Record<string, any> {
    return { ...el, isDeleted: true, version: el.version + 1, versionNonce: randomInt(), updated: Date.now() };
  }

  function editingTextId(api: ExcalidrawAPI): string | null {
    const s = api.getAppState();
    return s.editingTextElement?.id ?? s.editingElement?.id ?? null;
  }

  // Éditeur de texte d'Excalidraw ouvert : on ne touche à rien
  function isTyping(): boolean {
    return document.querySelector(".excalidraw-wysiwyg") !== null;
  }

  function scheduleLatexScan(): void {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanLatex, 400);
  }

  function scanLatex(): void {
    const api = watchedAPI;
    if (!api || latexDisabled() || api.getAppState().viewModeEnabled) return;
    if (isTyping()) {
      scheduleLatexScan();
      return;
    }
    const editingId = editingTextId(api);
    const items = [];
    for (const el of api.getSceneElements?.() ?? []) {
      if (el.type !== "text" || el.containerId || el.locked || el.id === editingId) continue;
      if (latexSeen.get(el.id) === el.version) continue;
      const source: string = el.originalText ?? el.text ?? "";
      if (!source.includes("$")) continue;
      latexSeen.set(el.id, el.version);
      items.push({
        id: el.id,
        version: el.version,
        source,
        fontSize: el.fontSize,
        color: el.strokeColor,
        align: el.textAlign,
      });
    }
    if (items.length) {
      window.postMessage({ source: "excalihub-bridge-event", type: "latex-candidates", items });
    }
  }

  // Sauvegarde automatique : on signale au content script que le dessin a
  // changé, avec une signature légère (nombre d'éléments, somme des versions,
  // fond) pour qu'il n'enregistre que les vrais changements.
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  function sceneSignature(api: ExcalidrawAPI): string {
    const elements = api.getSceneElements?.() ?? [];
    let versions = 0;
    for (const el of elements) versions += el.version;
    return `${elements.length}:${versions}:${api.getAppState().viewBackgroundColor}`;
  }

  function notifySceneChange(): void {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (!watchedAPI) return;
      window.postMessage({
        source: "excalihub-bridge-event",
        type: "scene-changed",
        signature: sceneSignature(watchedAPI),
      });
    }, 500);
  }

  function watchLatex(): void {
    setInterval(() => {
      const api = findAPI();
      if (api && api !== watchedAPI && api.onChange) {
        watchedAPI = api;
        healHidden(api);
        api.onChange(() => {
          scheduleLatexScan();
          notifySceneChange();
          refreshStepsUI();
          scheduleLineage();
        });
        scheduleLatexScan();
        refreshStepsUI();
        scheduleLineage();
      }
    }, 1000);
  }

  // Décalage horizontal (repère du texte) du centre de la formule par rapport
  // au centre du texte, selon l'alignement : la formule reste « à sa place ».
  function alignOffset(align: string, textWidth: number, imageWidth: number): number {
    if (align === "left") return (imageWidth - textWidth) / 2;
    if (align === "right") return (textWidth - imageWidth) / 2;
    return 0;
  }

  function buildFormulaImage(text: Record<string, any>, fileId: string, width: number, height: number) {
    const angle = text.angle ?? 0;
    const offset = alignOffset(text.textAlign, text.width, width);
    const cx = text.x + text.width / 2 + offset * Math.cos(angle);
    const cy = text.y + text.height / 2 + offset * Math.sin(angle);
    const { customData, ...snapshot } = JSON.parse(JSON.stringify(text));
    const { excalihubLatex: _previous, ...otherData } = customData ?? {};

    return {
      id: randomId(),
      type: "image",
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      angle,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: text.opacity ?? 100,
      groupIds: [...(text.groupIds ?? [])],
      frameId: text.frameId ?? null,
      index: null, // recalculé par Excalidraw
      roundness: null,
      seed: randomInt(),
      version: 1,
      versionNonce: randomInt(),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: text.link ?? null,
      locked: false,
      status: "saved",
      fileId,
      scale: [1, 1],
      crop: null,
      customData: { ...otherData, excalihubLatex: { text: snapshot, height } },
    };
  }

  function replaceWithFormulas(api: ExcalidrawAPI, results: FormulaResult[]): void {
    const editingId = editingTextId(api);
    const elements = allElements(api);
    const selected = { ...api.getAppState().selectedElementIds };
    const files: Record<string, any>[] = [];

    for (const r of results) {
      const index = elements.findIndex((el) => el.id === r.id);
      const text = elements[index];
      // Texte modifié ou rouvert entre-temps : on le laisse tel quel
      if (!text || text.isDeleted || text.version !== r.version || text.id === editingId) continue;

      const fileId = randomId(40);
      const now = Date.now();
      files.push({ id: fileId, dataURL: r.dataURL, mimeType: "image/svg+xml", created: now, lastRetrieved: now });
      const image = buildFormulaImage(text, fileId, r.width, r.height);
      // L'image prend la place du texte dans l'ordre d'affichage
      elements.splice(index, 1, deleted(text), image);
      if (selected[text.id]) {
        delete selected[text.id];
        selected[image.id] = true;
      }
    }

    if (files.length === 0) return;
    // Texte en cours de création ou d'édition (éditeur pas encore affiché
    // compris) : on réessaiera une fois l'éditeur fermé
    if (isTyping() || editingTextId(api)) {
      // Saisie en cours ailleurs : on réessaiera une fois l'éditeur fermé
      results.forEach((r) => latexSeen.delete(r.id));
      scheduleLatexScan();
      return;
    }
    api.addFiles?.(files);
    api.updateScene({ elements, appState: { selectedElementIds: selected } });
  }

  // Double-clic sur une formule : retour au texte source, éditeur ouvert
  function editFormula(api: ExcalidrawAPI, image: Record<string, any>): void {
    const meta = image.customData.excalihubLatex;
    const snapshot = meta.text;
    const scale = meta.height > 0 ? image.height / meta.height : 1;
    const width = snapshot.width * scale;
    const height = snapshot.height * scale;
    const angle = image.angle ?? 0;
    const offset = alignOffset(snapshot.textAlign, width, image.width);
    const cx = image.x + image.width / 2 - offset * Math.cos(angle);
    const cy = image.y + image.height / 2 - offset * Math.sin(angle);
    const { excalihubLatex: _meta, ...otherData } = image.customData;

    const text: Record<string, any> = {
      ...snapshot,
      id: randomId(),
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      fontSize: snapshot.fontSize * scale,
      angle,
      opacity: image.opacity,
      groupIds: [...(image.groupIds ?? [])],
      frameId: image.frameId ?? null,
      index: null,
      seed: randomInt(),
      version: 1,
      versionNonce: randomInt(),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      locked: false,
    };
    if (Object.keys(otherData).length) text.customData = otherData;

    const elements = allElements(api);
    const index = elements.findIndex((el) => el.id === image.id);
    elements.splice(index, 1, deleted(image), text);
    api.updateScene({ elements, appState: { selectedElementIds: { [text.id]: true } } });

    // Entrée sur un texte sélectionné = l'éditer (raccourci d'Excalidraw)
    setTimeout(() => {
      document.querySelector(".excalidraw")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
      );
      // Si l'éditeur ne s'est pas ouvert, le texte reste en source (pas de
      // reconversion immédiate) : un double-clic dessus permet de l'éditer.
      setTimeout(() => {
        if (!isTyping()) latexSeen.set(text.id, text.version);
      }, 300);
    }, 50);
  }

  function hitsElement(el: Record<string, any>, x: number, y: number): boolean {
    // Point ramené dans le repère de l'élément (rotation autour du centre)
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const cos = Math.cos(-(el.angle ?? 0));
    const sin = Math.sin(-(el.angle ?? 0));
    const lx = (x - cx) * cos - (y - cy) * sin;
    const ly = (x - cx) * sin + (y - cy) * cos;
    return Math.abs(lx) <= el.width / 2 && Math.abs(ly) <= el.height / 2;
  }

  document.addEventListener(
    "dblclick",
    (e: MouseEvent) => {
      if (latexDisabled() || !(e.target instanceof HTMLCanvasElement)) return;
      const api = findAPI();
      if (!api || !api.getSceneElements) return;
      const s = api.getAppState();
      if (s.viewModeEnabled) return;

      const zoom = s.zoom.value;
      const x = (e.clientX - (s.offsetLeft ?? 0)) / zoom - s.scrollX;
      const y = (e.clientY - (s.offsetTop ?? 0)) / zoom - s.scrollY;
      // La sélection reflète le test de clic d'Excalidraw (1er clic du double-clic)
      const formula = api
        .getSceneElements()
        .find(
          (el) =>
            s.selectedElementIds?.[el.id] &&
            el.type === "image" &&
            !el.locked &&
            el.customData?.excalihubLatex &&
            hitsElement(el, x, y),
        );
      if (!formula) return;

      // Avant Excalidraw (qui ouvrirait le recadrage de l'image)
      e.preventDefault();
      e.stopImmediatePropagation();
      editFormula(api, formula);
    },
    true,
  );

  // Entrée sur une formule sélectionnée : même effet que le double-clic
  // (comme pour un texte), au lieu du recadrage d'image d'Excalidraw.
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !e.isTrusted) return;
      if (latexDisabled() || isTyping()) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      const api = findAPI();
      if (!api || !api.getSceneElements) return;
      const s = api.getAppState();
      if (s.viewModeEnabled) return;

      const selected = api.getSceneElements().filter((el) => s.selectedElementIds?.[el.id]);
      const formula = selected[0];
      if (selected.length !== 1 || formula.type !== "image" || formula.locked || !formula.customData?.excalihubLatex) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      editFormula(api, formula);
    },
    true,
  );

  // Ctrl+X : ouvre / ferme le panneau Excalihub quand rien n'est sélectionné et
  // qu'aucun texte n'est en cours de saisie ; sinon Ctrl+X reste « Couper ».
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== "KeyX") return;
      const target = e.target as HTMLElement | null;
      if (isTyping() || target?.closest?.("input, textarea, [contenteditable='true']")) return;
      const api = findAPI();
      const selected = api?.getAppState().selectedElementIds ?? {};
      if (Object.values(selected).some(Boolean)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.postMessage({ source: "excalihub-bridge-event", type: "toggle-panel" });
    },
    true,
  );

  watchLatex();

  // ── Apparition progressive (diaporama) ────────────────────────────────
  // Étape d'un élément (customData.excalihubStep : 1, 2, 3…) : il apparaît au
  // clic correspondant pendant le diaporama ; sans étape, il est visible dès
  // l'arrivée sur la slide. Le texte d'un conteneur suit son conteneur.
  const STEP_KEY = "excalihubStep";
  // Élément masqué pendant le diaporama : son opacité d'origine, gardée sur
  // l'élément. Rien n'est perdu si l'onglet se ferme en pleine présentation.
  const HIDDEN_KEY = "excalihubHidden";
  // Masquer, réafficher : ni annulable (Ctrl+Z), ni enregistré comme une
  // modification (versions inchangées, donc rien à synchroniser)
  const NOT_RECORDED = { captureUpdate: "NEVER", storeAction: "none", commitToHistory: false };

  type ElementsById = Map<string, Record<string, any>>;

  const isFrame = (el: Record<string, any>) => el.type === "frame" || el.type === "magicframe";

  function ownStep(el: Record<string, any> | undefined): number | null {
    const step = el?.customData?.[STEP_KEY];
    return typeof step === "number" && step >= 1 ? step : null;
  }

  function stepOf(el: Record<string, any>, byId: ElementsById): number | null {
    return ownStep(el) ?? (el.containerId ? ownStep(byId.get(el.containerId)) : null);
  }

  function frameOf(el: Record<string, any>, byId: ElementsById): string | null {
    return el.frameId ?? (el.containerId ? (byId.get(el.containerId)?.frameId ?? null) : null);
  }

  // Étapes d'un frame, dans l'ordre
  function frameSteps(elements: readonly Record<string, any>[], byId: ElementsById, frameId: string): number[] {
    const steps = new Set<number>();
    for (const el of elements) {
      if (el.isDeleted || frameOf(el, byId) !== frameId) continue;
      const step = stepOf(el, byId);
      if (step !== null) steps.add(step);
    }
    return [...steps].sort((a, b) => a - b);
  }

  const isHidden = (el: Record<string, any>) => el.customData?.[HIDDEN_KEY] !== undefined;

  function hideElement(el: Record<string, any>): Record<string, any> {
    return { ...el, opacity: 0, customData: { ...el.customData, [HIDDEN_KEY]: el.opacity ?? 100 } };
  }

  function unhideElement(el: Record<string, any>): Record<string, any> {
    const { [HIDDEN_KEY]: opacity, ...customData } = el.customData;
    return { ...el, opacity: typeof opacity === "number" ? opacity : 100, customData };
  }

  // Copie temporaire d'un élément, dessinée pendant un Morph (voir morph)
  const MORPH_KEY = "excalihubMorph";
  const isMorphCopy = (el: Record<string, any>) => el.customData?.[MORPH_KEY] === true;

  // Dessin tel qu'enregistré : rien de masqué, aucune copie de Morph
  // (enregistrements, page chargée, onglet rouvert après une présentation interrompue)
  function cleanScene(elements: Record<string, any>[]): Record<string, any>[] {
    return elements.filter((el) => !isMorphCopy(el)).map((el) => (isHidden(el) ? unhideElement(el) : el));
  }

  function healHidden(api: ExcalidrawAPI): void {
    if (document.body.classList.contains("excalihub-presenting")) return;
    const elements = allElements(api);
    if (elements.some((el) => isHidden(el) || isMorphCopy(el))) {
      api.updateScene({ ...NOT_RECORDED, elements: cleanScene(elements) });
    }
  }

  // Dernière étape visible d'un frame dont `revealed` étapes sont apparues
  // (0 : aucune ; Infinity : toutes)
  function shownStep(steps: number[], revealed: number): number {
    return revealed >= steps.length ? Infinity : revealed > 0 ? steps[revealed - 1] : 0;
  }

  // Diaporama : sur le frame affiché, seules les `revealed` premières étapes
  // sont visibles (frameId null : tout réapparaît). Cadrage (appState) dans la
  // même mise à jour : jamais d'image intermédiaire. Renvoie le nombre d'étapes.
  function presentSlide(
    api: ExcalidrawAPI,
    frameId: string | null,
    revealed: number,
    appState?: Record<string, any>,
  ): number {
    finishAnimation();
    const all = allElements(api);
    const elements = all.filter((el) => !isMorphCopy(el));
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    const steps = frameId ? frameSteps(elements, byId, frameId) : [];
    const shown = shownStep(steps, revealed);
    let changed = elements.length !== all.length;
    const next = elements.map((el) => {
      const step = frameId && !el.isDeleted && frameOf(el, byId) === frameId ? stepOf(el, byId) : null;
      const hide = step !== null && step > shown;
      if (hide === isHidden(el)) return el;
      changed = true;
      return hide ? hideElement(el) : unhideElement(el);
    });
    if (changed || appState) {
      api.updateScene({ ...NOT_RECORDED, ...(changed ? { elements: next } : {}), ...(appState ? { appState } : {}) });
    }
    return steps.length;
  }

  // ── Morph, Pan & zoom (diaporama) ─────────────────────────────────────
  // Animations jouées sur le canevas lui-même, entre deux slides d'une même
  // page. Rien n'est enregistré : versions inchangées, copies temporaires
  // retirées à la fin (et ignorées par getScene, effacées au rechargement).
  const MORPH_MAX_COST = 0.8; // au-delà, deux éléments ne sont pas « le même »

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a: number, b: number, e: number) => a + (b - a) * e;

  // Animation en cours : si une autre commande du diaporama arrive avant la
  // fin, on applique directement son état final
  let animation: { frame: number; finish: () => void } | null = null;

  function finishAnimation(): void {
    if (!animation) return;
    const { frame, finish } = animation;
    animation = null;
    cancelAnimationFrame(frame);
    finish();
  }

  // step(e, t) : e avec accélération et ralentissement, t linéaire
  function animate(duration: number, step: (e: number, t: number) => void, finish: () => void): void {
    const start = performance.now();
    const tick = (now: number) => {
      if (!animation) return;
      const t = (now - start) / duration;
      if (t >= 1) {
        animation = null;
        finish();
        return;
      }
      step(ease(Math.max(0, t)), Math.max(0, t));
      animation.frame = requestAnimationFrame(tick);
    };
    animation = { frame: requestAnimationFrame(tick), finish };
    step(0, 0);
  }

  // Couleurs : mélange progressif (toute couleur CSS, « transparent » compris)
  const colorProbe = document.createElement("canvas").getContext("2d");
  const colorCache = new Map<string, number[] | null>();

  function parseColor(color: string): number[] | null {
    if (colorCache.has(color)) return colorCache.get(color)!;
    let rgba: number[] | null = null;
    if (colorProbe && typeof color === "string") {
      colorProbe.fillStyle = "#010203";
      colorProbe.fillStyle = color;
      const value = String(colorProbe.fillStyle);
      const hex = /^#([0-9a-f]{6})$/i.exec(value);
      const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
      if (value === "#010203" && color.toLowerCase() !== "#010203") rgba = null; // couleur refusée
      else if (hex) rgba = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
      else if (fn) rgba = fn[1].split(",").map(Number).concat(1).slice(0, 4);
    }
    colorCache.set(color, rgba);
    return rgba;
  }

  const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

  function mixColor(a: string, b: string, e: number): string {
    if (a === b) return a;
    const ca = parseColor(a);
    const cb = parseColor(b);
    if (!ca || !cb) return e < 0.5 ? a : b;
    // Depuis ou vers « transparent » : seule l'opacité change, pas la teinte
    const from = ca[3] === 0 ? [...cb.slice(0, 3), 0] : ca;
    const to = cb[3] === 0 ? [...ca.slice(0, 3), 0] : cb;
    const [r, g, bl, alpha] = from.map((v, i) => lerp(v, to[i], e));
    return `#${hex2(r)}${hex2(g)}${hex2(bl)}${alpha >= 0.999 ? "" : hex2(alpha * 255)}`;
  }

  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  function boxOf(el: Record<string, any>): Box {
    const [x, y] = topLeft(el);
    return { x, y, w: el.width, h: el.height };
  }

  const lerpBox = (a: Box, b: Box, e: number): Box => ({
    x: lerp(a.x, b.x, e),
    y: lerp(a.y, b.y, e),
    w: lerp(a.w, b.w, e),
    h: lerp(a.h, b.h, e),
  });

  // Élément redimensionné pour occuper `box` (un texte suit la hauteur)
  function fitTo(el: Record<string, any>, box: Box): Record<string, any> {
    const own = boxOf(el);
    const sx = own.w > 0.01 ? box.w / own.w : 1;
    const sy = own.h > 0.01 ? box.h / own.h : 1;
    const out: Record<string, any> = {
      ...el,
      width: el.width * sx,
      height: el.height * sy,
      strokeWidth: (el.strokeWidth ?? 1) * Math.sqrt(sx * sy),
    };
    if (Array.isArray(el.points)) {
      out.points = el.points.map((p: number[]) => [p[0] * sx, p[1] * sy]);
      out.x = box.x - (own.x - el.x) * sx;
      out.y = box.y - (own.y - el.y) * sy;
    } else {
      out.x = box.x;
      out.y = box.y;
    }
    if (el.type === "text") out.fontSize = el.fontSize * sy;
    return out;
  }

  // Filiation pour le Morph : chaque élément d'une slide garde l'identifiant de
  // l'élément dont il est la copie (customData.excalihubKey). Excalidraw
  // recopie customData en dupliquant et en collant : une slide dupliquée puis
  // modifiée retrouve exactement ses éléments, comme les noms d'objets de
  // PowerPoint. Posé au repos (pas pendant un dessin, une saisie, le diaporama).
  const LINEAGE_KEY = "excalihubKey";
  let lineageTimer: ReturnType<typeof setTimeout> | null = null;

  const lineageOf = (el: Record<string, any>): string | null =>
    typeof el.customData?.[LINEAGE_KEY] === "string" ? el.customData[LINEAGE_KEY] : null;

  function scheduleLineage(): void {
    if (lineageTimer) clearTimeout(lineageTimer);
    lineageTimer = setTimeout(tagLineage, 1500);
  }

  function tagLineage(): void {
    lineageTimer = null;
    const api = findAPI();
    if (!api) return;
    const s = api.getAppState();
    const busy =
      s.viewModeEnabled || s.editingTextElement || s.editingElement || s.newElement || s.draggingElement ||
      s.resizingElement || s.multiElement || s.selectionElement || s.isResizing || s.isRotating ||
      s.cursorButton === "down" || isTyping();
    if (busy || /(^|[#&])room=/.test(location.hash)) {
      scheduleLineage(); // plus tard, au repos (jamais en session collaborative)
      return;
    }
    const elements = allElements(api);
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    const untagged = (el: Record<string, any>) =>
      !el.isDeleted && !isFrame(el) && !isMorphCopy(el) && !lineageOf(el) && frameOf(el, byId) !== null;
    if (!elements.some(untagged)) return;
    api.updateScene({
      ...NOT_RECORDED, // pas d'entrée Ctrl+Z ; versions augmentées : enregistré et synchronisé
      elements: elements.map((el) =>
        untagged(el)
          ? {
              ...el,
              customData: { ...el.customData, [LINEAGE_KEY]: el.id },
              version: (el.version ?? 0) + 1,
              versionNonce: randomInt(),
              updated: Date.now(),
            }
          : el,
      ),
    });
  }

  // Ce qui distingue un texte ou une image : son contenu
  function contentKey(el: Record<string, any>): string | null {
    if (el.type === "text") return `text:${el.originalText ?? el.text}`;
    if (el.type !== "image") return null;
    const latex = el.customData?.excalihubLatex?.text;
    return latex ? `tex:${latex.originalText ?? latex.text}` : `image:${el.fileId}`;
  }

  // Mêmes caractéristiques : un seul élément qui se transforme ; sinon fondu
  // enchaîné entre les deux, qui suivent le même mouvement
  const SAME_LOOK = ["type", "fillStyle", "strokeStyle", "roughness", "fontFamily", "textAlign", "verticalAlign",
    "startArrowhead", "endArrowhead", "fileId", "text", "elbowed"];

  function canBlend(a: Record<string, any>, b: Record<string, any>): boolean {
    if (SAME_LOOK.some((key) => a[key] !== b[key])) return false;
    if (JSON.stringify(a.roundness ?? null) !== JSON.stringify(b.roundness ?? null)) return false;
    if (JSON.stringify(a.crop ?? null) !== JSON.stringify(b.crop ?? null)) return false;
    return (a.points?.length ?? 0) === (b.points?.length ?? 0);
  }

  function blend(a: Record<string, any>, b: Record<string, any>, e: number): Record<string, any> {
    const out: Record<string, any> = { ...b };
    for (const key of ["x", "y", "width", "height", "strokeWidth", "opacity", "fontSize"]) {
      if (typeof a[key] === "number" && typeof b[key] === "number") out[key] = lerp(a[key], b[key], e);
    }
    // Rotation par le plus court chemin
    const from = a.angle ?? 0;
    out.angle = from + Math.atan2(Math.sin((b.angle ?? 0) - from), Math.cos((b.angle ?? 0) - from)) * e;
    out.strokeColor = mixColor(a.strokeColor, b.strokeColor, e);
    out.backgroundColor = mixColor(a.backgroundColor, b.backgroundColor, e);
    if (Array.isArray(a.points) && Array.isArray(b.points)) {
      out.points = b.points.map((p: number[], i: number) => [lerp(a.points[i][0], p[0], e), lerp(a.points[i][1], p[1], e)]);
    }
    return out;
  }

  // Éléments communs aux deux slides, comme le Morph de PowerPoint : même texte
  // ou même image d'abord, sinon même type au même endroit (à l'écran) avec un
  // style et une taille proches. Les plus évidents sont appariés en premier.
  function matchElements(
    fromEls: Record<string, any>[],
    toEls: Record<string, any>[],
    frameA: Record<string, any>,
    frameB: Record<string, any>,
    zA: number,
    zB: number,
  ): Map<Record<string, any>, Record<string, any>> {
    const diagonal = Math.hypot(window.innerWidth, window.innerHeight);
    // Point de repère à l'écran (un texte : selon son alignement) ; les deux
    // slides sont calées en haut à gauche de l'écran
    const anchor = (el: Record<string, any>, frame: Record<string, any>, z: number) => {
      const box = boxOf(el);
      const share = el.type === "text" ? ({ left: 0, center: 0.5, right: 1 } as Record<string, number>)[el.textAlign] ?? 0 : 0.5;
      const y = el.type === "text" ? box.y : box.y + box.h / 2;
      return { x: (box.x + box.w * share - frame.x) * z, y: (y - frame.y) * z, w: box.w * z, h: box.h * z };
    };
    const candidates: { a: Record<string, any>; b: Record<string, any>; cost: number }[] = [];
    for (const a of fromEls) {
      const pa = anchor(a, frameA, zA);
      const keyA = contentKey(a);
      const lineage = lineageOf(a);
      for (const b of toEls) {
        const pb = anchor(b, frameB, zB);
        const distance = Math.hypot(pb.x - pa.x, pb.y - pa.y) / diagonal;
        let cost: number;
        if (lineage && lineage === lineageOf(b)) {
          cost = 0.01 * distance; // copie de l'élément (slide dupliquée) : forcément lui
        } else if (a.type !== b.type) {
          continue;
        } else if (keyA !== null && keyA === contentKey(b)) {
          cost = 0.1 + 0.1 * distance; // même texte, même image : c'est le même objet
        } else {
          const restyled = ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle", "fontFamily"].filter(
            (key) => a[key] !== b[key],
          ).length;
          // Taille : corps du texte ; sinon diagonale (une ligne n'a pas de hauteur)
          const resized =
            a.type === "text"
              ? Math.abs(Math.log((b.fontSize * zB) / (a.fontSize * zA)))
              : Math.abs(Math.log((Math.hypot(pb.w, pb.h) + 1) / (Math.hypot(pa.w, pa.h) + 1)));
          cost = distance + 0.35 * restyled + 0.25 * resized + (keyA !== null ? 0.3 : 0);
        }
        if (cost <= MORPH_MAX_COST) candidates.push({ a, b, cost });
      }
    }
    candidates.sort((p, q) => p.cost - q.cost);
    const pairs = new Map<Record<string, any>, Record<string, any>>();
    const taken = new Set<Record<string, any>>();
    for (const { a, b } of candidates) {
      if (pairs.has(a) || taken.has(b)) continue;
      pairs.set(a, b);
      taken.add(b);
    }
    return pairs;
  }

  // Morph de la slide affichée (fromFrameId) vers la suivante : les éléments
  // communs glissent, changent de taille, d'angle et de couleur ; les autres
  // apparaissent ou disparaissent en fondu. La caméra passe d'emblée sur la
  // slide d'arrivée, entièrement masquée : ce sont des copies temporaires qui
  // dessinent l'animation, puis la vraie slide réapparaît à l'identique.
  function morph(
    api: ExcalidrawAPI,
    fromFrameId: string,
    toFrameId: string,
    revealed: number,
    appState: Record<string, any>,
    duration: number,
  ): number {
    finishAnimation();
    const elements = allElements(api).filter((el) => !isMorphCopy(el));
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    const frameA = byId.get(fromFrameId);
    const frameB = byId.get(toFrameId);
    if (!frameA || !frameB || frameA.isDeleted || frameB.isDeleted) {
      return presentSlide(api, toFrameId, revealed, appState);
    }
    const zA = api.getAppState().zoom.value;
    const zB = appState.zoom?.value ?? zA;
    const k = zA / zB;

    const steps = frameSteps(elements, byId, toFrameId);
    const shown = shownStep(steps, revealed);
    const inFrame = (el: Record<string, any>, frameId: string) =>
      !el.isDeleted && !isFrame(el) && frameOf(el, byId) === frameId;
    // Slide quittée telle qu'affichée, slide d'arrivée telle qu'elle doit apparaître
    const fromEls = elements.filter((el) => inFrame(el, fromFrameId) && !isHidden(el) && (el.opacity ?? 100) > 0);
    const toEls = elements
      .filter((el) => inFrame(el, toFrameId) && (stepOf(el, byId) ?? 0) <= shown)
      .map((el) => (isHidden(el) ? unhideElement(el) : el));

    const pairs = matchElements(fromEls, toEls, frameA, frameB, zA, zB);
    const fromOf = new Map([...pairs].map(([a, b]) => [b, a]));
    // Élément de la slide quittée, au même endroit de l'écran une fois la caméra
    // sur la slide d'arrivée (frames de tailles différentes compris)
    const mapped = new Map(
      fromEls.map((el) => {
        const own = boxOf(el);
        const box = { x: frameB.x + (own.x - frameA.x) * k, y: frameB.y + (own.y - frameA.y) * k, w: own.w * k, h: own.h * k };
        return [el, fitTo(el, box)];
      }),
    );

    // Copies, dans l'ordre d'affichage : ce qui disparaît, puis la slide d'arrivée
    const parts: ((e: number) => Record<string, any>[])[] = [];
    for (const a of fromEls) {
      if (pairs.has(a)) continue;
      const m = mapped.get(a)!;
      parts.push((e) => [{ ...m, opacity: (m.opacity ?? 100) * (1 - e) }]);
    }
    for (const b of toEls) {
      const a = fromOf.get(b);
      if (!a) {
        parts.push((e) => [{ ...b, opacity: (b.opacity ?? 100) * e }]);
        continue;
      }
      const m = mapped.get(a)!;
      if (canBlend(m, b)) {
        parts.push((e) => [blend(m, b, e)]);
        continue;
      }
      // Contenu différent (texte modifié, autre formule…) : fondu enchaîné
      const boxA = boxOf(m);
      const boxB = boxOf(b);
      parts.push((e) => {
        const box = lerpBox(boxA, boxB, e);
        return [
          { ...fitTo(m, box), opacity: (m.opacity ?? 100) * (1 - e) },
          { ...fitTo(b, box), opacity: (b.opacity ?? 100) * e },
        ];
      });
    }

    // La slide d'arrivée reste masquée pendant l'animation (étapes comprises)
    const base = elements.map((el) => (inFrame(el, toFrameId) && !isHidden(el) ? hideElement(el) : el));
    let frameNo = 0;
    animate(
      duration,
      (e) => {
        frameNo++;
        const copies = parts
          .flatMap((part) => part(e))
          .map((el, i) => ({
            ...el,
            id: `excalihub-morph-${i}`,
            index: null,
            frameId: null,
            containerId: null,
            groupIds: [],
            boundElements: null,
            startBinding: null,
            endBinding: null,
            link: null,
            locked: true,
            isDeleted: false,
            version: frameNo,
            versionNonce: frameNo,
            customData: { [MORPH_KEY]: true },
          }));
        api.updateScene({ ...NOT_RECORDED, elements: [...base, ...copies], ...(frameNo === 1 ? { appState } : {}) });
      },
      () => presentSlide(api, toFrameId, revealed, appState),
    );
    return steps.length;
  }

  // Pan & zoom : la caméra voyage sur le canevas jusqu'à la slide suivante,
  // en prenant du recul à mi-parcours pour montrer le chemin
  function fly(
    api: ExcalidrawAPI,
    frameId: string | null,
    revealed: number,
    appState: Record<string, any>,
    duration: number,
  ): number {
    finishAnimation();
    const all = allElements(api);
    const elements = all.filter((el) => !isMorphCopy(el));
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    const steps = frameId ? frameSteps(elements, byId, frameId) : [];
    const shown = shownStep(steps, revealed);
    // Étapes à venir de la slide d'arrivée masquées dès le départ ; la slide
    // quittée reste telle qu'elle était affichée
    let changed = elements.length !== all.length;
    const start = elements.map((el) => {
      const step = frameId && !el.isDeleted && frameOf(el, byId) === frameId ? stepOf(el, byId) : null;
      if (step === null || step <= shown || isHidden(el)) return el;
      changed = true;
      return hideElement(el);
    });
    if (changed) api.updateScene({ ...NOT_RECORDED, elements: start });

    const s = api.getAppState();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const zA = s.zoom.value;
    const zB = appState.zoom?.value ?? zA;
    // Centre de l'écran, en coordonnées du dessin, au départ et à l'arrivée
    const from = { x: vw / (2 * zA) - s.scrollX, y: vh / (2 * zA) - s.scrollY };
    const to = { x: vw / (2 * zB) - appState.scrollX, y: vh / (2 * zB) - appState.scrollY };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const zMid = Math.min(zA, zB, vw / (distance + 0.25 * (vw / zA + vw / zB)));
    const zoomAt = (a: number, b: number, e: number) => Math.exp(lerp(Math.log(a), Math.log(b), e));
    animate(
      duration,
      (e, t) => {
        const zoom = t < 0.5 ? zoomAt(zA, zMid, ease(t * 2)) : zoomAt(zMid, zB, ease(t * 2 - 1));
        const x = lerp(from.x, to.x, e);
        const y = lerp(from.y, to.y, e);
        api.updateScene({ appState: { scrollX: vw / (2 * zoom) - x, scrollY: vh / (2 * zoom) - y, zoom: { value: zoom } } });
      },
      () => presentSlide(api, frameId, revealed, appState),
    );
    return steps.length;
  }

  function withStep(el: Record<string, any>, step: number | null): Record<string, any> {
    if (ownStep(el) === step) return el;
    const { [STEP_KEY]: _old, ...rest } = el.customData ?? {};
    const customData = step ? { ...rest, [STEP_KEY]: step } : rest;
    return {
      ...el,
      customData: Object.keys(customData).length ? customData : undefined,
      version: (el.version ?? 0) + 1,
      versionNonce: randomInt(),
      updated: Date.now(),
    };
  }

  // Étape choisie dans le panneau pour la sélection : un numéro, null (visible
  // dès l'arrivée) ou "next" (nouveau clic, après le dernier du frame)
  function setStep(api: ExcalidrawAPI, value: number | null | "next"): void {
    const selected = api.getAppState().selectedElementIds ?? {};
    const elements = allElements(api);
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    const targets = new Set<string>();
    for (const el of elements) {
      if (el.isDeleted || !selected[el.id] || isFrame(el) || !frameOf(el, byId)) continue;
      targets.add(el.id);
      // Conteneur et texte : toujours ensemble
      for (const bound of el.boundElements ?? []) if (bound.type === "text") targets.add(bound.id);
      if (el.containerId) targets.add(el.containerId);
    }
    if (targets.size === 0) return;

    // Dernière étape des autres éléments de chaque frame
    const last = new Map<string, number>();
    for (const el of elements) {
      const frameId = frameOf(el, byId);
      const step = stepOf(el, byId);
      if (el.isDeleted || !frameId || step === null || targets.has(el.id)) continue;
      last.set(frameId, Math.max(last.get(frameId) ?? 0, step));
    }
    const touched = new Set<string>();
    let next = elements.map((el) => {
      if (!targets.has(el.id)) return el;
      const frameId = frameOf(el, byId)!;
      touched.add(frameId);
      return withStep(el, value === "next" ? (last.get(frameId) ?? 0) + 1 : value);
    });

    // Étapes renumérotées 1, 2, 3… dans chaque frame touché (jamais de trou)
    const nextById: ElementsById = new Map(next.map((el) => [el.id, el]));
    for (const frameId of touched) {
      const rank = new Map(frameSteps(next, nextById, frameId).map((step, i) => [step, i + 1]));
      next = next.map((el) => {
        const own = ownStep(el);
        if (own === null || el.isDeleted || frameOf(el, nextById) !== frameId) return el;
        return withStep(el, rank.get(own) ?? own);
      });
    }
    // Annulable (Ctrl+Z), comme toute modification du dessin
    api.updateScene({ elements: next, captureUpdate: "IMMEDIATELY", storeAction: "capture", commitToHistory: true });
  }

  // Onglet Slides ouvert : numéros d'étape posés sur le dessin (comme les
  // repères d'animation de PowerPoint) et sélection signalée au panneau
  let stepsUI = false;
  let selectionKey = "";
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let badgesFrame = 0;
  let badgesLayer: HTMLElement | null = null;

  function setStepsUI(on: boolean): void {
    stepsUI = on;
    selectionKey = ""; // l'état courant est renvoyé au panneau
    if (on) refreshStepsUI();
    else badgesLayer?.replaceChildren();
  }

  function refreshStepsUI(): void {
    if (!stepsUI) return;
    badgesFrame ||= requestAnimationFrame(renderBadges);
    selectionTimer ??= setTimeout(notifySelection, 120);
  }

  function notifySelection(): void {
    selectionTimer = null;
    const api = findAPI();
    if (!stepsUI || !api?.getSceneElements) return;
    const s = api.getAppState();
    const elements = api.getSceneElements();
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    // Texte d'un conteneur sélectionné : compté avec lui
    const selected = elements.filter(
      (el) => s.selectedElementIds?.[el.id] && !isFrame(el) && !(el.containerId && s.selectedElementIds?.[el.containerId]),
    );
    const frames = new Set<string>();
    const steps = new Set<number | null>();
    let outside = 0;
    for (const el of selected) {
      const frameId = frameOf(el, byId);
      if (!frameId) {
        outside++;
        continue;
      }
      frames.add(frameId);
      steps.add(stepOf(el, byId));
    }
    const frameId = frames.size === 1 ? [...frames][0] : null;
    const info = {
      count: selected.length - outside, // éléments dans un frame
      frames: frames.size,
      outside,
      step: steps.size === 1 ? [...steps][0] : steps.size ? "mixed" : null,
      frameSteps: frameId ? frameSteps(elements, byId, frameId).length : 0,
    };
    const key = JSON.stringify(info);
    if (key === selectionKey) return;
    selectionKey = key;
    window.postMessage({ source: "excalihub-bridge-event", type: "selection", info });
  }

  // Coin haut gauche d'un élément (lignes, flèches et tracés : leurs points)
  function topLeft(el: Record<string, any>): [number, number] {
    if (!Array.isArray(el.points) || el.points.length === 0) return [el.x, el.y];
    return [el.x + Math.min(...el.points.map((p: number[]) => p[0])), el.y + Math.min(...el.points.map((p: number[]) => p[1]))];
  }

  function renderBadges(): void {
    badgesFrame = 0;
    const api = findAPI();
    if (!stepsUI || !api?.getSceneElements) return;
    const s = api.getAppState();
    const elements = api.getSceneElements();
    const byId: ElementsById = new Map(elements.map((el) => [el.id, el]));
    // Un repère par groupe (ou par élément) et par étape, à son coin haut gauche
    const marks = new Map<string, { step: number; x: number; y: number }>();
    for (const el of elements) {
      if (el.containerId || isFrame(el) || !frameOf(el, byId)) continue;
      const step = stepOf(el, byId);
      if (step === null) continue;
      const key = `${el.groupIds?.[el.groupIds.length - 1] ?? el.id}:${step}`;
      const [x, y] = topLeft(el);
      const mark = marks.get(key);
      if (mark) {
        mark.x = Math.min(mark.x, x);
        mark.y = Math.min(mark.y, y);
      } else {
        marks.set(key, { step, x, y });
      }
    }
    if (!badgesLayer) {
      badgesLayer = document.createElement("div");
      badgesLayer.className = "excalihub-step-badges";
      document.body.appendChild(badgesLayer);
    }
    const zoom = s.zoom.value;
    badgesLayer.replaceChildren(
      ...[...marks.values()].map((mark) => {
        const badge = document.createElement("div");
        badge.className = "excalihub-step-badge";
        badge.textContent = String(mark.step);
        badge.style.left = `${(mark.x + s.scrollX) * zoom + (s.offsetLeft ?? 0)}px`;
        badge.style.top = `${(mark.y + s.scrollY) * zoom + (s.offsetTop ?? 0)}px`;
        return badge;
      }),
    );
  }

  // Ordre des slides : rangé dans customData de chaque frame, il voyage avec
  // le dessin (page, fichier, OneDrive)
  interface SlideMeta {
    order: number;
    section: { id: string; name: string } | null;
  }

  function setSlideMeta(api: ExcalidrawAPI, meta: Record<string, SlideMeta>): void {
    let changed = false;
    const elements = allElements(api).map((el) => {
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
        version: el.version + 1,
        versionNonce: randomInt(),
        updated: Date.now(),
      };
    });
    if (changed) api.updateScene({ elements });
  }

  // ── Export SVG des slides (PDF vectoriel) ─────────────────────────────
  // Rendu par Excalidraw lui-même, avec son action « Copier en SVG » : même
  // résultat que son export d'image (thème clair, polices incluses), cadré sur
  // la frame sans nom ni contour, ce qui la chevauche compris (comme sur le
  // canevas). Toutes les étapes sont visibles.
  interface FrameSvg {
    svg: string;
    width: number; // taille de la frame (unités du dessin)
    height: number;
  }

  // Composant App d'Excalidraw (ses actions), au-dessus de l'élément .excalidraw
  function findApp(): any {
    const el = document.querySelector(".excalidraw");
    const fiberKey =
      el && Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    let fiber: any = fiberKey ? (el as any)[fiberKey] : null;
    while (fiber) {
      if (fiber.stateNode?.actionManager?.actions) return fiber.stateNode;
      fiber = fiber.return;
    }
    return null;
  }

  // L'action écrit le SVG dans le presse-papier : on le récupère au passage,
  // sans toucher au presse-papier (méthodes d'origine rétablies ensuite)
  async function copyAsSvg(app: any, elements: Record<string, any>[], appState: Record<string, any>): Promise<string> {
    const action = app.actionManager.actions.copyAsSvg;
    if (typeof action?.perform !== "function") throw new Error("This version of Excalidraw cannot export SVG");
    const clipboard = navigator.clipboard as any;
    const captured: { svg?: string } = {};
    clipboard.writeText = async (text: string) => {
      captured.svg ??= text;
    };
    // Au cas où une version passerait par ClipboardItem
    clipboard.write = async (items: ClipboardItem[]) => {
      for (const item of items) {
        const type = item.types.find((t) => t === "image/svg+xml" || t === "text/plain");
        if (type) captured.svg ??= await (await item.getType(type)).text();
      }
    };
    try {
      const result = await action.perform(elements, appState, null, app);
      if (result?.appState?.errorMessage) throw new Error(result.appState.errorMessage);
    } finally {
      delete clipboard.writeText;
      delete clipboard.write;
    }
    if (!captured.svg?.startsWith("<svg")) throw new Error("SVG export failed");
    return captured.svg;
  }

  // Frames de la page affichée, ou d'une autre page (scène enregistrée, passée
  // par le content script : rien ne change à l'écran). null : frame introuvable.
  async function exportFrameSvgs(
    api: ExcalidrawAPI,
    frameIds: string[],
    scene?: SceneData,
  ): Promise<{ frames: (FrameSvg | null)[]; background: string }> {
    const app = findApp();
    if (!app) throw new Error("Excalidraw not found");
    const state = api.getAppState();
    // Dessin tel qu'enregistré : rien de masqué par le diaporama
    const elements = cleanScene(scene ? scene.elements : allElements(api));
    const background: string = scene ? (scene.appState?.viewBackgroundColor ?? "#ffffff") : state.viewBackgroundColor;
    // Images d'une autre page : prêtées à l'export seulement, pas ajoutées au canevas
    const files = scene ? { ...app.files, ...scene.files } : app.files;
    const source = scene ? new Proxy(app, { get: (target, key) => (key === "files" ? files : Reflect.get(target, key)) }) : app;

    const frames: (FrameSvg | null)[] = [];
    for (const frameId of frameIds) {
      const frame = elements.find((el) => el.id === frameId && !el.isDeleted && isFrame(el));
      if (!frame) {
        frames.push(null);
        continue;
      }
      const svg = await copyAsSvg(source, elements, {
        ...state,
        selectedElementIds: { [frameId]: true }, // une frame seule sélectionnée : export cadré sur elle
        exportBackground: true,
        exportWithDarkMode: false,
        exportEmbedScene: false,
        exportScale: 1,
        viewBackgroundColor: background,
      });
      frames.push({ svg, width: frame.width, height: frame.height });
    }
    return { frames, background };
  }

  window.addEventListener("message", function (e: MessageEvent) {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== "excalihub-content") return;

    const { id, method, args = [] } = e.data as BridgeMessage;
    const api = findAPI();

    if (method === "ping") {
      window.postMessage({ source: "excalihub-bridge", id, result: !!api });
      return;
    }

    if (!api) {
      window.postMessage({ source: "excalihub-bridge", id, error: "API not found" });
      return;
    }

    try {
      if (method === "getAppState") {
        const s = api.getAppState();
        window.postMessage({
          source: "excalihub-bridge",
          id,
          result: {
            scrollX: s.scrollX,
            scrollY: s.scrollY,
            zoom: { value: s.zoom.value },
            frameRendering: {
              enabled: s.frameRendering.enabled,
              name: s.frameRendering.name,
              outline: s.frameRendering.outline,
              clip: s.frameRendering.clip,
            },
            viewModeEnabled: s.viewModeEnabled,
            theme: s.theme,
            viewBackgroundColor: s.viewBackgroundColor,
          },
        });
      } else if (method === "updateScene") {
        api.updateScene(args[0]);
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "getScene") {
        window.postMessage({ source: "excalihub-bridge", id, result: getScene(api) });
      } else if (method === "setSlideMeta") {
        setSlideMeta(api, args[0] as Record<string, SlideMeta>);
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "getSignature") {
        window.postMessage({ source: "excalihub-bridge", id, result: sceneSignature(api) });
      } else if (method === "loadScene") {
        loadScene(api, args[0] as SceneData);
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "replaceWithFormulas") {
        replaceWithFormulas(api, args[0] as FormulaResult[]);
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "presentSlide") {
        const { frameId = null, revealed = Infinity, appState } = (args[0] ?? {}) as {
          frameId?: string | null;
          revealed?: number;
          appState?: Record<string, any>;
        };
        window.postMessage({ source: "excalihub-bridge", id, result: presentSlide(api, frameId, revealed, appState) });
      } else if (method === "morph" || method === "fly") {
        // L'animation se déroule ensuite seule ; réponse immédiate (nombre d'étapes)
        const { fromFrameId, toFrameId, revealed = 0, appState, duration = 600 } = (args[0] ?? {}) as {
          fromFrameId: string;
          toFrameId: string | null;
          revealed?: number;
          appState: Record<string, any>;
          duration?: number;
        };
        const total =
          method === "morph" && toFrameId
            ? morph(api, fromFrameId, toFrameId, revealed, appState, duration)
            : fly(api, toFrameId, revealed, appState, duration);
        window.postMessage({ source: "excalihub-bridge", id, result: total });
      } else if (method === "setStep") {
        setStep(api, args[0] as number | null | "next");
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "setStepsUI") {
        setStepsUI(!!args[0]);
        window.postMessage({ source: "excalihub-bridge", id, result: true });
      } else if (method === "exportFrameSvgs") {
        // Réponse à la fin de l'export (polices chargées et intégrées au SVG)
        const { frameIds, scene } = args[0] as { frameIds: string[]; scene?: SceneData };
        exportFrameSvgs(api, frameIds, scene).then(
          (result) => window.postMessage({ source: "excalihub-bridge", id, result }),
          (err: unknown) =>
            window.postMessage({ source: "excalihub-bridge", id, error: err instanceof Error ? err.message : String(err) }),
        );
      } else {
        window.postMessage({ source: "excalihub-bridge", id, error: "Unknown method: " + method });
      }
    } catch (err: unknown) {
      window.postMessage({
        source: "excalihub-bridge",
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
})();
