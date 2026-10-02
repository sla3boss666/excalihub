// Captures d'écran du canevas Excalidraw (transitions et aperçus des slides)
import { callBridge, waitForRender } from "./bridgeClient";
import { fitFrame, PresentationFrame, ScreenRect, SLIDE_FRAME_RENDERING } from "./frames";

export function getStaticCanvas(): HTMLCanvasElement | null {
  return (
    (document.querySelector(".excalidraw__canvas.static") as HTMLCanvasElement) ??
    (document.querySelector(".excalidraw__canvas") as HTMLCanvasElement)
  );
}

// Excalidraw inverse les couleurs du canevas en thème sombre via un filtre CSS :
// il faut le reporter sur les copies pour qu'elles s'affichent pareil.
export function canvasFilter(): string {
  const source = getStaticCanvas();
  return source ? getComputedStyle(source).filter : "none";
}

// Transformation des couleurs en thème sombre. Les versions récentes
// d'Excalidraw l'appliquent directement au dessin (équivalent, à ±1 près, du
// filtre ci-dessous) ; les anciennes posaient ce filtre en CSS sur le canevas.
const DARK_THEME_FILTER = "invert(93%) hue-rotate(180deg)";

export function themeColorFilter(theme: string): string {
  const css = canvasFilter();
  if (css && css !== "none") return css;
  return theme === "dark" ? DARK_THEME_FILTER : "none";
}

// Couleur réellement affichée pour une couleur du canevas (un fond
// transparent laisse voir du blanc).
export function displayedColor(color: string, filter: string): string {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return color;
  ctx.filter = filter || "none";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

// Copie la zone `rect` (coordonnées écran) du canevas. drawImage ne lève pas
// d'erreur même si le canevas contient des images d'une autre origine.
export function captureRect(rect: ScreenRect): HTMLCanvasElement | null {
  const source = getStaticCanvas();
  if (!source || rect.width <= 0 || rect.height <= 0) return null;

  const sourceRect = source.getBoundingClientRect();
  const sx = source.width / sourceRect.width;
  const sy = source.height / sourceRect.height;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(rect.width * sx));
  out.height = Math.max(1, Math.round(rect.height * sy));
  out.getContext("2d")?.drawImage(
    source,
    (rect.left - sourceRect.left) * sx,
    (rect.top - sourceRect.top) * sy,
    rect.width * sx,
    rect.height * sy,
    0,
    0,
    out.width,
    out.height,
  );
  return out;
}

export function scaleCanvas(source: HTMLCanvasElement, maxWidth: number): HTMLCanvasElement {
  const ratio = Math.min(1, maxWidth / source.width);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(source.width * ratio));
  out.height = Math.max(1, Math.round(source.height * ratio));
  const ctx = out.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, out.width, out.height);
  }
  return out;
}

// Aperçus : on cadre brièvement chaque frame derrière un cache, on copie
// le rendu, puis on rend la vue d'origine.
export async function captureThumbnails(
  frames: PresentationFrame[],
  maxWidth = 640,
): Promise<Map<string, HTMLCanvasElement>> {
  const thumbs = new Map<string, HTMLCanvasElement>();
  if (frames.length === 0) return thumbs;

  const original = await callBridge<any>("getAppState");

  const cover = document.createElement("div");
  cover.className = "excalihub-capture-cover";
  cover.textContent = "Creating previews…";
  document.body.appendChild(cover);

  try {
    for (const frame of frames) {
      const view = fitFrame(frame);
      await callBridge("updateScene", {
        appState: {
          scrollX: view.scrollX,
          scrollY: view.scrollY,
          zoom: { value: view.zoom },
          frameRendering: SLIDE_FRAME_RENDERING,
        },
      });
      await waitForRender();
      const shot = captureRect(view.rect);
      if (shot) thumbs.set(frame.id, scaleCanvas(shot, maxWidth));
    }
  } finally {
    await callBridge("updateScene", {
      appState: {
        scrollX: original.scrollX,
        scrollY: original.scrollY,
        zoom: original.zoom,
        frameRendering: original.frameRendering,
      },
    }).catch(() => {});
    await waitForRender(1);
    cover.remove();
  }

  return thumbs;
}
