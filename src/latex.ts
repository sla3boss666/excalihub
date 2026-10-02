// Rendu LaTeX → SVG avec MathJax, entièrement local (aucune requête réseau).
// Module chargé à la demande par le content script, la première fois qu'une
// formule est détectée (MathJax pèse lourd, inutile de le charger sinon).
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";

import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/amscd/AmsCdConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/braket/BraketConfiguration.js";
import "mathjax-full/js/input/tex/cancel/CancelConfiguration.js";
import "mathjax-full/js/input/tex/cases/CasesConfiguration.js";
import "mathjax-full/js/input/tex/color/ColorConfiguration.js";
import "mathjax-full/js/input/tex/enclose/EncloseConfiguration.js";
import "mathjax-full/js/input/tex/extpfeil/ExtpfeilConfiguration.js";
import "mathjax-full/js/input/tex/gensymb/GensymbConfiguration.js";
import "mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/physics/PhysicsConfiguration.js";
import "mathjax-full/js/input/tex/upgreek/UpgreekConfiguration.js";

const PACKAGES = [
  "base", "ams", "amscd", "boldsymbol", "braket", "cancel", "cases", "color", "enclose",
  "extpfeil", "gensymb", "mathtools", "mhchem", "newcommand", "physics", "upgreek",
];

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

// Les caractères absents des polices TeX (é, ç, °, €…) sont écrits en <text>
// avec une police système. Sans DOM, MathJax leur suppose une largeur fixe
// (0,6 em), d'où des trous ou chevauchements : on les mesure vraiment.
const measure = document.createElement("canvas").getContext("2d")!;
(adaptor as any).nodeSize = (node: any, em = 1): [number, number] => {
  const size = parseFloat(adaptor.getAttribute(node, "font-size")) || em;
  const style = adaptor.getAttribute(node, "font-style") === "italic" ? "italic " : "";
  const weight = adaptor.getAttribute(node, "font-weight") === "bold" ? "bold " : "";
  measure.font = `${style}${weight}${size}px ${adaptor.getAttribute(node, "font-family") || "serif"}`;
  return [measure.measureText(adaptor.textContent(node)).width / em, (0.8 * size) / em];
};

// Pas de rendu « en rouge » des erreurs : on veut les signaler à l'utilisateur
const tex = new TeX({
  packages: PACKAGES,
  formatError: (_jax: unknown, err: Error) => {
    throw err;
  },
});
const svgOutput = new SVG({ fontCache: "local" });
const doc = mathjax.document("", { InputJax: tex, OutputJax: svgOutput });

// ── Texte Excalidraw → LaTeX ─────────────────────────────────────────
// $…$ : formule en ligne, $$…$$ : formule en bloc, \$ : dollar littéral.
// Comme pandoc, un $ ouvrant doit être suivi d'un caractère non blanc et un $
// fermant précédé d'un non blanc et non suivi d'un chiffre (« 5 $ et 10 $ »
// reste du texte).
type Segment = { kind: "text" | "inline" | "display"; value: string };

function splitMath(source: string): Segment[] | null {
  const segments: Segment[] = [];
  let text = "";
  let i = 0;
  let found = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\" && source[i + 1] === "$") {
      text += "$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      const display = source[i + 1] === "$";
      const open = display ? 2 : 1;
      const close = findClosing(source, i + open, display);
      if (close >= 0) {
        if (text) segments.push({ kind: "text", value: text });
        text = "";
        segments.push({ kind: display ? "display" : "inline", value: source.slice(i + open, close).trim() });
        i = close + open;
        found = true;
        continue;
      }
    }
    text += ch;
    i++;
  }
  if (text) segments.push({ kind: "text", value: text });
  return found ? segments : null;
}

function findClosing(source: string, start: number, display: boolean): number {
  if (display) {
    const end = source.indexOf("$$", start);
    return end > start ? end : -1;
  }
  if (start >= source.length || /\s/.test(source[start])) return -1;
  for (let j = start; j < source.length; j++) {
    if (source[j] === "\\") {
      j++; // caractère échappé, dont \$
      continue;
    }
    if (source[j] === "\n") return -1; // une formule en ligne tient sur une ligne
    if (source[j] === "$") {
      if (/\s/.test(source[j - 1]) || /\d/.test(source[j + 1] ?? "")) continue;
      return j;
    }
  }
  return -1;
}

// Texte ordinaire en mode texte de MathJax ; les caractères spéciaux de TeX
// sortent en mode math pour rester affichés tels quels.
function textToTex(value: string): string {
  const special: Record<string, string> = {
    "\\": "\\backslash ", "{": "\\{", "}": "\\}", "%": "\\%", "&": "\\&", "#": "\\#", "$": "\\$",
  };
  let out = "";
  let run = "";
  for (const ch of value) {
    if (special[ch]) {
      if (run) out += `\\text{${run}}`;
      run = "";
      out += special[ch];
    } else {
      run += ch;
    }
  }
  if (run) out += `\\text{${run}}`;
  return out;
}

export function hasMath(source: string): boolean {
  return splitMath(source) !== null;
}

export function sourceToTex(source: string, align: string): string | null {
  const segments = splitMath(source);
  if (!segments) return null;

  // Découpage en lignes : retours à la ligne du texte, et une ligne par bloc $$…$$
  const rows: string[] = [];
  let row = "";
  let afterDisplay = false;
  for (const seg of segments) {
    if (seg.kind === "display") {
      if (row.trim()) rows.push(row);
      rows.push(`\\displaystyle{${seg.value}}`);
      row = "";
      afterDisplay = true;
      continue;
    }
    if (seg.kind === "inline") {
      row += `{${seg.value}}`;
    } else {
      // Le retour à la ligne qui suit un bloc $$…$$ ne crée pas de ligne vide
      const value = afterDisplay && seg.value.startsWith("\n") ? seg.value.slice(1) : seg.value;
      const lines = value.split("\n");
      row += textToTex(lines[0]);
      for (const line of lines.slice(1)) {
        rows.push(row);
        row = textToTex(line);
      }
    }
    afterDisplay = false;
  }
  rows.push(row);
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  if (rows.length <= 1) return rows[0] ?? "";

  const column = align === "center" ? "c" : align === "right" ? "r" : "l";
  return `\\begin{array}{${column}}${rows.map((r) => r || "\\text{}").join("\\\\")}\\end{array}`;
}

export interface RenderedFormula {
  svg: string;
  width: number; // px, à la taille de police demandée
  height: number;
}

// Rend en SVG. `fontSize` = taille du texte Excalidraw (px par em) ;
// le SVG est agrandi (`resolution`) pour rester net quand on zoome.
export function renderTex(texSource: string, fontSize: number, color: string, resolution = 4): RenderedFormula {
  const node = doc.convert(texSource, { display: false, em: fontSize, ex: fontSize / 2, containerWidth: 4000 });
  const svgNode = adaptor.firstChild(node) as any;

  // viewBox en millièmes d'em : dimensions exactes en px
  const [, , vbWidth, vbHeight] = String(adaptor.getAttribute(svgNode, "viewBox")).split(/\s+/).map(Number);
  const width = (vbWidth / 1000) * fontSize;
  const height = (vbHeight / 1000) * fontSize;

  adaptor.setAttribute(svgNode, "width", String(width * resolution));
  adaptor.setAttribute(svgNode, "height", String(height * resolution));
  adaptor.setAttribute(svgNode, "color", color);
  adaptor.removeAttribute(svgNode, "style");
  adaptor.removeAttribute(svgNode, "role");
  adaptor.removeAttribute(svgNode, "focusable");

  return { svg: adaptor.outerHTML(svgNode), width, height };
}
