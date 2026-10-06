// Export PDF des slides, en vectoriel : Excalidraw exporte chaque slide en SVG
// (comme son export d'image : thème clair, polices incluses, toutes étapes
// visibles), puis Chrome imprime ces SVG en PDF (voir pdf.ts). Rien ne bouge à
// l'écran : les slides des autres pages sont lues dans leur enregistrement.
// Page aux proportions de l'écran, slide calée en haut à gauche comme dans le
// diaporama. À appeler dans runExclusive (lecture des pages enregistrées).
import { callBridgeWithTimeout } from "./bridgeClient";
import { PresentationFrame } from "./frames";
import { EMPTY_SCENE, getPagesIndex, readStoredScene } from "./pages";
import { buildPdf, PdfSlide } from "./pdf";

const PAGE_WIDTH = 1280; // px CSS : 13,33 pouces, comme une diapositive PowerPoint
// Premier export : Excalidraw charge les polices à inclure
const EXPORT_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_PER_SLIDE_MS = 5_000;

interface FrameSvgs {
  frames: ({ svg: string; width: number; height: number } | null)[]; // null : frame introuvable
  background: string;
}

// Renvoie le PDF, ou null s'il a été enregistré depuis la fenêtre d'impression
export async function exportSlidesPdf(
  slides: PresentationFrame[],
  title: string,
  onProgress: (done: number, total: number) => void,
): Promise<Blob | null> {
  const index = await getPagesIndex();
  // Slides regroupées par page : chaque page enregistrée n'est transmise qu'une fois
  const byPage = new Map<string, number[]>();
  slides.forEach((slide, position) => {
    const pageId = slide.pageId ?? index.currentId;
    byPage.set(pageId, [...(byPage.get(pageId) ?? []), position]);
  });

  const pages: PdfSlide[] = [];
  let done = 0;
  for (const [pageId, positions] of byPage) {
    // Page affichée : le canevas ; autre page : son enregistrement
    const scene = pageId === index.currentId ? undefined : ((await readStoredScene(pageId)) ?? EMPTY_SCENE);
    const { frames, background } = await callBridgeWithTimeout<FrameSvgs>(
      EXPORT_TIMEOUT_MS + positions.length * EXPORT_TIMEOUT_PER_SLIDE_MS,
      "exportFrameSvgs",
      { frameIds: positions.map((position) => slides[position].id), scene },
    );
    positions.forEach((position, i) => {
      const frame = frames[i];
      if (!frame) throw new Error(`Slide "${slides[position].name}" not found: refresh the slide list.`);
      pages[position] = { ...frame, background };
    });
    done += positions.length;
    onProgress(done, slides.length);
  }

  // Proportions du diaporama : celles de l'écran (plein écran)
  const aspect = screen.width / screen.height;
  return buildPdf(pages, PAGE_WIDTH, Math.round(PAGE_WIDTH / aspect), title);
}
