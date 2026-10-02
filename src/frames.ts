// Lecture des frames de la scène et cadrage à l'écran
export interface PresentationFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageId?: string; // page d'origine (diaporama sur toutes les pages)
}

// Section de slides (comme dans PowerPoint), rangée sur chaque frame
export interface SectionRef {
  id: string;
  name: string;
}

export interface SceneFrame extends PresentationFrame {
  order: number | null; // ordre choisi dans le panneau (customData.excalihubSlide)
  section: SectionRef | null; // customData.excalihubSection
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameView {
  scrollX: number;
  scrollY: number;
  zoom: number;
  rect: ScreenRect; // position du frame à l'écran une fois cadré
}

// localStorage est partagé avec la page : Excalidraw y garde la scène courante
export function readSceneElements(): any[] {
  const raw = localStorage.getItem("excalidraw");
  if (!raw) return [];
  try {
    const elements = JSON.parse(raw);
    return Array.isArray(elements) ? elements : [];
  } catch {
    return [];
  }
}

export function getFramesFromScene(): SceneFrame[] {
  return framesFromElements(readSceneElements());
}

// Frames d'une scène (page affichée ou page enregistrée), dans l'ordre des slides
export function framesFromElements(all: any[]): SceneFrame[] {
  const elements = all.filter((el: any) => el.type === "frame" && !el.isDeleted);
  // Ordre choisi dans le panneau, enregistré sur chaque frame (customData)
  const savedOrder = new Map<string, number>(
    elements
      .filter((el: any) => typeof el.customData?.excalihubSlide === "number")
      .map((el: any) => [el.id, el.customData.excalihubSlide]),
  );
  const frames: SceneFrame[] = elements.map((el: any) => {
    const section = el.customData?.excalihubSection;
    return {
      id: el.id,
      name: el.name || "Frame",
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      order: typeof el.customData?.excalihubSlide === "number" ? el.customData.excalihubSlide : null,
      section: section?.id ? { id: String(section.id), name: String(section.name ?? "") } : null,
    };
  });

  const allSameName = frames.length > 1 && frames.every((f) => f.name === frames[0]?.name);
  if (allSameName) {
    frames.sort((a, b) => {
      const rowThreshold = 100;
      if (Math.abs(a.y - b.y) < rowThreshold) return a.x - b.x;
      return a.y - b.y;
    });
  } else {
    frames.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
  }

  // Les frames déjà ordonnées d'abord, dans l'ordre choisi ; les nouvelles
  // à la suite, dans l'ordre par défaut (le tri est stable)
  if (savedOrder.size > 0) {
    const rank = (f: PresentationFrame) => savedOrder.get(f.id) ?? Number.MAX_SAFE_INTEGER;
    frames.sort((a, b) => rank(a) - rank(b));
  }

  return frames;
}

// Somme des versions des éléments : change dès que la scène est modifiée
// (même principe que getSceneVersion d'Excalidraw).
export function getSceneVersion(): number {
  return readSceneElements().reduce((sum: number, el: any) => sum + (el.version ?? 0), 0);
}

// Cadrage « plein écran » : le frame remplit l'écran sans marge, comme une slide
export function fitFrame(
  frame: PresentationFrame,
  vw = window.innerWidth,
  vh = window.innerHeight,
): FrameView {
  const zoom = Math.min(vw / frame.width, vh / frame.height);
  const width = frame.width * zoom;
  const height = frame.height * zoom;
  return {
    zoom,
    scrollX: vw / (2 * zoom) - (frame.x + frame.width / 2),
    scrollY: vh / (2 * zoom) - (frame.y + frame.height / 2),
    rect: { left: (vw - width) / 2, top: (vh - height) / 2, width, height },
  };
}

// Rendu du frame seul : ni nom, ni contour, contenu découpé au cadre
export const SLIDE_FRAME_RENDERING = { enabled: true, name: false, outline: false, clip: true };
