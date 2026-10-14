// Rendu Markdown minimal et sûr pour les réponses du chat. Tout le texte est
// échappé d'abord ; seules nos propres balises sont ensuite générées (pas de
// HTML venant du modèle). Les blocs de code, le code en ligne et les maths
// sont mis de côté avant tout traitement (jetons en zone privée Unicode),
// puis réinsérés à la fin. Les formules $…$ / $$…$$ sont rendues après coup
// avec MathJax (même module local que les formules du canevas, latex.ts).

type LatexModule = typeof import("./latex");

let latexModule: Promise<LatexModule> | null = null;

function loadLatex(): Promise<LatexModule> {
  latexModule ??= import(/* @vite-ignore */ chrome.runtime.getURL("dist/latex.js"));
  return latexModule;
}

export interface MathSegment {
  tex: string;
  display: boolean;
  source: string; // texte d'origine, affiché tant que MathJax n'a pas rendu
}

export interface RenderedMarkdown {
  html: string;
  math: MathSegment[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Jetons invisibles survivant à l'échappement (zone privée Unicode)
const tok = (kind: string, i: number) => `${kind}${i}`;
const TOKEN_RE = /([a-z]+)(\d+)/g;
// Ligne ne contenant qu'un jeton de bloc de code (mêmes délimiteurs U+E000/U+E001)
const BLOCK_LINE_RE = /^\s*block\d+\s*$/;

function inline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s](?:[^*\n]*[^*\s])?)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

// ── Manies des modèles (surtout les gratuits) ───────────────────────
// Raisonnement livré dans la réponse (<think>…</think>, parfois <thinking>) :
// retiré. Un bloc non refermé (réponse en cours) est retiré aussi, et signalé.
const THINK_RE = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/gi;
const THINK_OPEN_RE = /<(think|thinking|reasoning)>[\s\S]*$/i;

export function stripThinking(src: string): { text: string; thinking: boolean } {
  const closed = src.replace(THINK_RE, "");
  const text = closed.replace(THINK_OPEN_RE, "");
  return { text: text.replace(/^\s+/, ""), thinking: text !== closed };
}

// Réponse qui dégénère (modèles gratuits sur réponse longue) : un caractère
// ou un court motif répété sans fin, ou bascule soudaine vers des idéogrammes
// dans une réponse qui n'en contenait pas. Renvoie l'indice où couper, ou -1.
const TAIL = 600; // seule la fin est examinée (le charabia ne fait que grandir)
const CJK_RE = /[　-ヿ㐀-鿿가-힯＀-￯]/g;

export function findGibberish(text: string): number {
  if (text.length < 120) return -1;
  const start = Math.max(0, text.length - TAIL);
  const tail = text.slice(start);
  let cut = -1;
  const consider = (i: number) => {
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  };

  // Même caractère non blanc 40 fois de suite, ou même motif (2 à 16
  // caractères sur une ligne, hors tableaux dont les lignes peuvent se
  // ressembler) 12 fois de suite
  const same = /(\S)\1{39,}/.exec(tail);
  if (same) consider(start + same.index);
  const motif = /(\S[^\n|]{1,15}?)\1{11,}/.exec(tail);
  if (motif) consider(start + motif.index);

  // Idéogrammes : plus de la moitié des 200 derniers caractères, alors que le
  // début de la réponse n'en avait presque pas
  const head = text.slice(0, 500);
  const headCjk = (head.match(CJK_RE) ?? []).length / Math.max(1, head.length);
  const last = text.slice(-200);
  const lastCjk = (last.match(CJK_RE) ?? []).length / Math.max(1, last.length);
  if (headCjk < 0.05 && lastCjk > 0.5) {
    CJK_RE.lastIndex = 0;
    const first = CJK_RE.exec(tail);
    CJK_RE.lastIndex = 0;
    if (first) consider(start + first.index);
  }
  if (cut < 0) return -1;

  // On recule jusqu'à la fin de phrase ou de ligne précédente (300 caractères
  // au plus) pour ne pas laisser un mot coupé
  const before = text.slice(Math.max(0, cut - 300), cut);
  const boundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf(". "), before.lastIndexOf(".\n"));
  return boundary > 0 ? cut - before.length + boundary + 1 : cut;
}

// Réponse entière emballée dans ```markdown … ``` : on déballe
function unwrapMarkdownFence(src: string): string {
  const m = /^\s*```(?:markdown|md)\s*\n([\s\S]*?)(?:\n```\s*)?$/i.exec(src);
  return m ? m[1] : src;
}

export function renderMarkdown(raw: string): RenderedMarkdown {
  const stripped = stripThinking(raw);
  const src = unwrapMarkdownFence(stripped.text);
  if (!src.trim() && stripped.thinking) {
    return { html: '<p class="excalihub-chat-thinking">Thinking…</p>', math: [] };
  }
  const codeBlocks: string[] = [];
  const codeLangs: string[] = [];
  const codeSpans: string[] = [];
  const math: MathSegment[] = [];

  // 1. Blocs de code ``` … ``` (avant tout : leur contenu reste intact)
  let text = src.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang: string, code: string) => {
    codeLangs.push(lang.trim().split(/\s+/)[0] ?? "");
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\n${tok("block", codeBlocks.length - 1)}\n`;
  });

  // 2. Code en ligne `…`
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(code);
    return tok("code", codeSpans.length - 1);
  });

  // 3. Maths : \[…\] et $$…$$ en bloc (peuvent s'étaler sur plusieurs
  //    lignes), \(…\) et $…$ en ligne. ChatGPT écrit surtout \[ \] / \( \).
  //    Pour $…$, règles pandoc : pas d'espace après le $ ouvrant ni avant le
  //    fermant, pas de chiffre après le fermant — « 5 $ et 10 $ » reste du texte
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex: string) => {
    math.push({ tex: tex.trim(), display: true, source: m });
    return tok("math", math.length - 1);
  });
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex: string) => {
    math.push({ tex: tex.trim(), display: true, source: m });
    return tok("math", math.length - 1);
  });
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex: string) => {
    math.push({ tex: tex.trim(), display: false, source: m });
    return tok("math", math.length - 1);
  });
  text = text.replace(/\$(?![\s$])((?:\\.|[^$\n\\])*?(?<![\s\\]))\$(?!\d)/g, (m, tex: string) => {
    math.push({ tex, display: false, source: m });
    return tok("math", math.length - 1);
  });

  // 4. Échappement global, puis analyse par blocs
  const lines = escapeHtml(text).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.kind}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.kind}>`);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  const isTableSeparator = (line?: string) => !!line && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
  const splitRow = (line: string) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    if (!line.trim()) {
      flush();
    } else if (BLOCK_LINE_RE.test(line)) {
      // Bloc de code seul sur sa ligne : élément de bloc, pas dans un <p>
      flush();
      out.push(line.trim());
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const level = Math.min(m[1].length, 4);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flush();
      const quote = [m[1]];
      while (i + 1 < lines.length && (m = lines[i + 1].match(/^&gt;\s?(.*)$/))) {
        quote.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      if (list?.kind !== "ul") flushList();
      list ??= { kind: "ul", items: [] };
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (list?.kind !== "ol") flushList();
      list ??= { kind: "ol", items: [] };
      list.items.push(m[1]);
    } else if (line.includes("|") && isTableSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      i++; // ligne de séparation
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) {
        rows.push(splitRow(lines[++i]));
      }
      const thead = `<tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`;
      const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<table>${thead}${tbody}</table>`);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flush();

  // 5. Réinsertion des jetons
  const html = out.join("").replace(TOKEN_RE, (_, kind: string, index: string) => {
    const n = Number(index);
    if (kind === "block") {
      const lang = codeLangs[n] ?? "";
      const label = lang ? `<span class="excalihub-chat-code-lang">${escapeHtml(lang)}</span>` : "";
      return `<pre>${label}<code>${escapeHtml(codeBlocks[n] ?? "")}</code></pre>`;
    }
    if (kind === "code") return `<code>${escapeHtml(codeSpans[n] ?? "")}</code>`;
    const seg = math[n];
    if (!seg) return "";
    // Le TeX voyage avec le span : hydrateMath n'a pas besoin de la liste
    // (utile quand le HTML est re-rendu en cours de réponse)
    return `<span class="excalihub-chat-math${seg.display ? " display" : ""}" data-tex="${escapeHtml(seg.tex)}">${escapeHtml(seg.source)}</span>`;
  });

  return { html, math };
}

// Formules déjà rendues (même TeX, même taille, même couleur) : une réponse
// en cours est re-rendue à chaque morceau reçu, inutile de refaire MathJax
const formulaCache = new Map<string, { svg: string; width: number; height: number }>();
const FORMULA_CACHE_MAX = 400;

// Remplace les segments $…$ par leur rendu MathJax (après insertion du HTML
// dans le DOM). En cas de TeX invalide, le texte d'origine reste affiché.
export async function hydrateMath(root: HTMLElement): Promise<void> {
  if (!root.querySelector(".excalihub-chat-math:not(.rendered)")) return;
  let latex: LatexModule;
  try {
    latex = await loadLatex();
  } catch {
    return; // module indisponible : les formules restent en texte
  }

  for (const span of root.querySelectorAll<HTMLElement>(".excalihub-chat-math:not(.rendered)")) {
    const tex = span.dataset.tex;
    if (!tex) continue;
    const display = span.classList.contains("display");
    try {
      const fontSize = display ? 15 : 13;
      const color = getComputedStyle(span).color || "currentColor";
      const key = `${display ? "D" : "I"}|${color}|${tex}`;
      let formula = formulaCache.get(key);
      if (!formula) {
        formula = latex.renderTex(display ? `\\displaystyle{${tex}}` : tex, fontSize, color, 2);
        if (formulaCache.size >= FORMULA_CACHE_MAX) formulaCache.clear();
        formulaCache.set(key, formula);
      }
      span.innerHTML = formula.svg;
      const svg = span.querySelector("svg");
      if (svg) {
        svg.style.width = `${formula.width}px`;
        svg.style.height = `${formula.height}px`;
      }
      span.classList.add("rendered");
    } catch {
      // TeX invalide : on garde le texte source tel quel
      span.classList.add("invalid");
    }
  }
}
