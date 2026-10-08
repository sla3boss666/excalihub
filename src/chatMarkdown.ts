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

function inline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s](?:[^*\n]*[^*\s])?)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

export function renderMarkdown(src: string): RenderedMarkdown {
  const codeBlocks: string[] = [];
  const codeSpans: string[] = [];
  const math: MathSegment[] = [];

  // 1. Blocs de code ``` … ``` (avant tout : leur contenu reste intact)
  let text = src.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, (_, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\n${tok("block", codeBlocks.length - 1)}\n`;
  });

  // 2. Code en ligne `…`
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(code);
    return tok("code", codeSpans.length - 1);
  });

  // 3. Maths : $$…$$ (peut s'étaler sur plusieurs lignes) puis $…$
  //    (règles pandoc : pas d'espace après le $ ouvrant ni avant le fermant,
  //    pas de chiffre après le fermant — « 5 $ et 10 $ » reste du texte)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex: string) => {
    math.push({ tex: tex.trim(), display: true, source: m });
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
    if (kind === "block") return `<pre><code>${escapeHtml(codeBlocks[n] ?? "")}</code></pre>`;
    if (kind === "code") return `<code>${escapeHtml(codeSpans[n] ?? "")}</code>`;
    const seg = math[n];
    if (!seg) return "";
    return `<span class="excalihub-chat-math${seg.display ? " display" : ""}" data-mi="${n}">${escapeHtml(seg.source)}</span>`;
  });

  return { html, math };
}

// Remplace les segments $…$ par leur rendu MathJax (après insertion du HTML
// dans le DOM). En cas de TeX invalide, le texte d'origine reste affiché.
export async function hydrateMath(root: HTMLElement, math: MathSegment[]): Promise<void> {
  if (math.length === 0) return;
  let latex: LatexModule;
  try {
    latex = await loadLatex();
  } catch {
    return; // module indisponible : les formules restent en texte
  }

  for (const span of root.querySelectorAll<HTMLElement>(".excalihub-chat-math:not(.rendered)")) {
    const seg = math[Number(span.dataset.mi)];
    if (!seg) continue;
    try {
      const fontSize = seg.display ? 15 : 13;
      const color = getComputedStyle(span).color || "currentColor";
      const tex = seg.display ? `\\displaystyle{${seg.tex}}` : seg.tex;
      const formula = latex.renderTex(tex, fontSize, color, 2);
      span.innerHTML = formula.svg;
      const svg = span.querySelector("svg");
      if (svg) {
        svg.style.width = `${formula.width}px`;
        svg.style.height = `${formula.height}px`;
      }
      span.classList.add("rendered");
    } catch {
      // TeX invalide : on garde le texte source tel quel
    }
  }
}
