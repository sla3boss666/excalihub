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
    // Copie JSON : les éléments d'Excalidraw sont figés et non clonables tels quels
    const elements = JSON.parse(JSON.stringify(api.getSceneElements()));

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
    const files = Object.values(scene.files ?? {});
    if (files.length && api.addFiles) api.addFiles(files);
    api.updateScene({
      elements: scene.elements ?? [],
      appState: {
        ...scene.appState,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      },
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
        api.onChange(() => {
          scheduleLatexScan();
          notifySceneChange();
        });
        scheduleLatexScan();
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
