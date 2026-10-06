// PDF vectoriel, par le moteur d'impression de Chrome (celui d'« Enregistrer
// au format PDF ») : les slides, en SVG, sont mises en page dans le document le
// temps de l'export, puis le service worker imprime l'onglet (Page.printToPDF).
// Tracés et formules restent vectoriels ; les textes gardent leurs polices,
// incluses dans le PDF (texte sélectionnable). Impression directe impossible :
// la fenêtre d'impression de Chrome prend le relais.

export interface PdfSlide {
  svg: string;
  width: number; // taille de la frame (unités du dessin)
  height: number;
  background: string; // fond de la page Excalidraw : bandes autour de la slide
}

const PRINT_ID = "excalihub-print";
const SVG_NS = "http://www.w3.org/2000/svg";
const WHITE = new Set(["#fff", "#ffffff", "white"]);
const BLACK = new Set(["#000", "#000000", "black"]);

// Le SVG d'Excalidraw vient d'un outerHTML (sérialisation HTML) : une espace
// insécable y devient &nbsp;, inconnu en XML, et un caractère de contrôle (texte
// collé) y est interdit. Une image SVG devant être du XML valide, ils
// empêcheraient d'afficher la slide.
function toXml(svg: string): string {
  return svg.replace(/&nbsp;/g, "&#160;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

// Contour d'un rectangle SVG, transformation comprise
function rectPath(rect: Element): string {
  const value = (name: string) => Number(rect.getAttribute(name)) || 0;
  const [x, y, w, h] = [value("x"), value("y"), value("width"), value("height")];
  const matrix = (rect as SVGRectElement).transform?.baseVal.consolidate()?.matrix ?? new DOMMatrix();
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].map(([px, py]) => new DOMPoint(px, py).matrixTransform(matrix));
  return `M${corners.map((p) => `${p.x} ${p.y}`).join(" L")} Z`;
}

// Excalidraw découpe une flèche autour de son étiquette avec un masque (zone
// visible en blanc, trou en noir), que Chrome imprimerait en image : remplacé
// par un découpage équivalent (clip-path pair-impair), qui reste vectoriel.
// Masque d'une autre forme : laissé tel quel.
function masksToClipPaths(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const masks = [...doc.getElementsByTagNameNS(SVG_NS, "mask")];
  for (const mask of masks) {
    const [visible, ...holes] = [...mask.children];
    const convertible =
      visible?.localName === "rect" &&
      WHITE.has(visible.getAttribute("fill") ?? "") &&
      holes.length > 0 &&
      holes.every(
        (rect) =>
          rect.localName === "rect" &&
          BLACK.has(rect.getAttribute("fill") ?? "") &&
          (rect.getAttribute("opacity") ?? "1") === "1",
      );
    if (!convertible) continue;

    const clip = doc.createElementNS(SVG_NS, "clipPath");
    clip.id = mask.id;
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", [visible, ...holes].map(rectPath).join(" "));
    path.setAttribute("clip-rule", "evenodd");
    clip.append(path);
    mask.replaceWith(clip);

    const ref = `url(#${mask.id})`;
    for (const user of doc.querySelectorAll("[mask]")) {
      if (user.getAttribute("mask") !== ref) continue;
      user.removeAttribute("mask");
      if (!user.hasAttribute("clip-path")) {
        user.setAttribute("clip-path", ref);
        continue;
      }
      // Déjà découpé : second découpage sur un groupe intérieur
      const group = doc.createElementNS(SVG_NS, "g");
      group.setAttribute("clip-path", ref);
      group.append(...user.childNodes);
      user.append(group);
    }
  }
  return masks.length ? new XMLSerializer().serializeToString(doc) : svg;
}

// Une page par slide, sans marge ; le reste du document n'est pas imprimé
function printStyle(width: number, height: number): string {
  const page = `#${PRINT_ID} > div`;
  return `
    #${PRINT_ID} { display: none; }
    @media print {
      @page { size: ${width}px ${height}px; margin: 0; }
      html, body {
        width: auto !important; height: auto !important; min-height: 0 !important; overflow: visible !important;
        margin: 0 !important; padding: 0 !important; background: none !important;
      }
      html > :not(head, body), body > :not(#${PRINT_ID}) { display: none !important; }
      #${PRINT_ID} { display: block; }
      ${page} {
        position: relative; width: ${width}px; height: ${height}px; overflow: hidden; break-after: page;
        print-color-adjust: exact; -webkit-print-color-adjust: exact;
      }
      ${page}:last-child { break-after: auto; }
      ${page} > img { position: absolute; left: 0; top: 0; display: block; }
    }`;
}

function pdfBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "application/pdf" });
}

// Pages de `width` × `height` px CSS (96 px par pouce). Renvoie le PDF, ou null
// s'il a été enregistré depuis la fenêtre d'impression.
export async function buildPdf(slides: PdfSlide[], width: number, height: number, title: string): Promise<Blob | null> {
  const style = document.createElement("style");
  style.textContent = printStyle(width, height);
  const box = document.createElement("div");
  box.id = PRINT_ID;
  const urls: string[] = [];
  const images = slides.map((slide) => {
    // Slide calée en haut à gauche, à la plus grande taille qui tient dans la page
    const scale = Math.min(width / slide.width, height / slide.height);
    const page = document.createElement("div");
    page.style.background = slide.background;
    // Une image par slide : chacune garde ses polices (Excalidraw n'y inclut que
    // les caractères de la slide, sous le même nom d'une slide à l'autre)
    const image = document.createElement("img");
    image.style.width = `${slide.width * scale}px`;
    image.style.height = `${slide.height * scale}px`;
    image.src = URL.createObjectURL(new Blob([masksToClipPaths(toXml(slide.svg))], { type: "image/svg+xml" }));
    urls.push(image.src);
    page.append(image);
    box.append(page);
    return image;
  });

  const documentTitle = document.title;
  document.head.append(style);
  document.body.append(box);
  try {
    await Promise.all(images.map((image) => image.decode()));
    document.title = title; // titre du PDF (et nom proposé par la fenêtre d'impression)
    const response = await chrome.runtime.sendMessage({ type: "excalihub:print-pdf" }).catch((err) => ({ error: err }));
    if (response?.data) return pdfBlob(response.data);
    console.warn("ExcaliFree: direct PDF export unavailable, opening the print dialog.", response?.error);
    // Destination « Enregistrer au format PDF » ; window.print() ne rend la
    // main qu'à la fermeture de la fenêtre : la mise en page reste jusque-là
    window.print();
    return null;
  } finally {
    document.title = documentTitle;
    style.remove();
    box.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
}
