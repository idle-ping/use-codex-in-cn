import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";

const languageByExtension = new Map([
  ["js", () => javascript({ jsx: false })],
  ["jsx", () => javascript({ jsx: true })],
  ["ts", () => javascript({ typescript: true })],
  ["tsx", () => javascript({ typescript: true, jsx: true })],
  ["json", () => json()],
  ["jsonc", () => json()],
  ["md", () => markdown()],
  ["markdown", () => markdown()],
  ["mdown", () => markdown()],
  ["py", () => python()],
  ["css", () => css()],
  ["html", () => html()],
  ["htm", () => html()],
  ["rs", () => rust()],
  ["sql", () => sql()],
  ["xml", () => xml()],
  ["svg", () => xml()],
]);

function extensionOf(path = "") {
  const filename = String(path).split(/[\\/]/).at(-1) || "";
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function languageName(path = "") {
  const extension = extensionOf(path);
  return {
    js: "JavaScript", jsx: "JavaScript JSX", ts: "TypeScript", tsx: "TypeScript JSX",
    json: "JSON", jsonc: "JSON", md: "Markdown", markdown: "Markdown", mdown: "Markdown",
    py: "Python", css: "CSS", html: "HTML", htm: "HTML", rs: "Rust", sql: "SQL",
    xml: "XML", svg: "XML",
  }[extension] || (extension ? extension.toUpperCase() : "Plain text");
}

function languageExtension(path = "") {
  return languageByExtension.get(extensionOf(path))?.() || [];
}

function darkMode() {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function themeExtension(dark) {
  return EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--app-text)",
      backgroundColor: "var(--app-main)",
      fontSize: "12px",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--mono)",
      lineHeight: "1.7",
    },
    ".cm-content": { padding: "12px 0 24px", caretColor: "transparent" },
    ".cm-line": { padding: "0 20px 0 10px" },
    ".cm-gutters": {
      minWidth: "58px",
      border: "0",
      backgroundColor: "var(--app-main)",
      color: "var(--app-text-tertiary)",
    },
    ".cm-gutterElement": { padding: "0 12px 0 8px" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--app-link) 20%, transparent)" },
    ".cm-search": { backgroundColor: "var(--app-panel)", border: "1px solid var(--app-border-default)" },
    ".cm-tooltip": { backgroundColor: "var(--app-panel)", color: "var(--app-text)", border: "1px solid var(--app-border-default)" },
    ".cm-file-reference-line": {
      backgroundColor: "color-mix(in srgb, var(--app-link) 12%, transparent)",
      boxShadow: "inset 3px 0 var(--app-link)",
    },
  }, { dark });
}

function referenceDecorations(state, lineStart, lineEnd) {
  if (!Number.isFinite(lineStart)) return Decoration.none;
  const start = Math.max(1, Math.floor(lineStart));
  const end = Math.max(start, Math.floor(lineEnd || lineStart));
  const ranges = [];
  for (let number = start; number <= end && number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    ranges.push(Decoration.line({ class: "cm-file-reference-line" }).range(line.from));
  }
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

export function createCodeViewer(container, {
  text = "",
  path = "",
  lineStart = null,
  lineEnd = null,
  wrap = false,
  syntaxHighlight = true,
  onCopy = null,
} = {}) {
  const wrapCompartment = new Compartment();
  const documentState = EditorState.create({ doc: String(text) });
  const state = EditorState.create({
    doc: String(text),
    extensions: [
      basicSetup,
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      search({ top: true }),
      keymap.of(searchKeymap),
      syntaxHighlight ? languageExtension(path) : [],
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        "aria-label": `${path || "Source code"} (read only)`,
        spellcheck: "false",
      }),
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
      EditorView.decorations.of(referenceDecorations(documentState, lineStart, lineEnd)),
      themeExtension(darkMode()),
    ],
  });
  const view = new EditorView({ state, parent: container });

  function revealLines(start = lineStart, end = lineEnd) {
    if (!Number.isFinite(start)) return;
    const first = Math.max(1, Math.min(view.state.doc.lines, Math.floor(start)));
    const last = Math.max(first, Math.min(view.state.doc.lines, Math.floor(end || start)));
    const from = view.state.doc.line(first).from;
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }

  async function copy() {
    const selection = view.state.selection.main;
    const value = selection.empty ? view.state.sliceDoc() : view.state.sliceDoc(selection.from, selection.to);
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
    await navigator.clipboard.writeText(value);
    onCopy?.(value);
    return value;
  }

  requestAnimationFrame(() => revealLines());
  return {
    view,
    language: languageName(path),
    focus: () => view.focus(),
    find: () => { view.focus(); openSearchPanel(view); },
    revealLines,
    setWrap(value) { view.dispatch({ effects: wrapCompartment.reconfigure(value ? EditorView.lineWrapping : []) }); },
    copy,
    destroy: () => view.destroy(),
  };
}
