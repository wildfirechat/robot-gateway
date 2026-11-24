/**
 * @wildfirechat/dsh-pdf
 *
 * Pure-JS PDF tools for the Wildfire DSH profile. The plugin keeps all files in
 * the caller's workspace: reads go through ctx.fs, binary outputs are resolved
 * through ctx.fs and then written atomically by the host filesystem adapter.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fontkit from "@pdf-lib/fontkit";

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
const MAX_DEFAULT = 128 * 1024 * 1024;

export const name = "dsh-pdf";
export const inject = ["tools", "fs", "workingDirectory", "agents"];

const RAW_OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  // DSH requires content blocks; returning null makes the session surface read
  // `.some` on null and fails every tool.
  render: (_args, value) => [{
    type: "text",
    text: (() => {
      try {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return text.length > 30000 ? `${text.slice(0, 30000)}…` : text;
      } catch {
        return String(value);
      }
    })(),
  }],
};

function rawTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: RAW_OUTPUT,
    async execute(args, exec) {
      return execute(args, exec);
    },
  };
}

function isInside(root, target) {
  const a = path.resolve(root);
  const b = path.resolve(target);
  const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return fold(a) === fold(b) || fold(b).startsWith(fold(a) + path.sep);
}

function errorMessage(error, code) {
  const message = String(error?.message ?? error ?? "PDF operation failed");
  return `${code}: ${message}`;
}

async function contextOf(ctx, exec) {
  if (!exec?.agent) throw new Error("PDF tools run only inside an Agent step");
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  return { cwd, signal: exec.signal };
}

async function inputTarget(ctx, exec, input) {
  const { cwd, signal } = await contextOf(ctx, exec);
  const target = await ctx.fs.resolve(String(input || ""), { cwd, signal });
  const info = await ctx.fs.stat(target, signal);
  if (!info || info.type !== "file") throw new Error(`not a regular file: ${target.displayPath}`);
  return { target, info, cwd, signal };
}

async function readInput(ctx, exec, input, maxBytes) {
  const { target, info, cwd, signal } = await inputTarget(ctx, exec, input);
  if (info.size != null && info.size > maxBytes) throw new Error(`file too large (${info.size} > ${maxBytes}): ${target.displayPath}`);
  const bytes = await ctx.fs.readBytes(target, signal, maxBytes);
  return { bytes: new Uint8Array(bytes), target, cwd, signal };
}

async function outputPath(ctx, exec, output, inputAbs, { mkdirs = false } = {}) {
  const { cwd, signal } = await contextOf(ctx, exec);
  const target = await ctx.fs.resolve(String(output || ""), { cwd, signal });
  const abs = ctx.fs.processPath(target);
  const rootTarget = await ctx.fs.resolve(".", { cwd, signal });
  const root = ctx.fs.processPath(rootTarget);
  if (!isInside(root, abs)) throw new Error(`output must stay inside the workspace: ${abs}`);
  if (inputAbs && path.resolve(abs) === path.resolve(inputAbs)) throw new Error("output must not overwrite the input file");
  if (mkdirs) await mkdir(path.dirname(abs), { recursive: true });
  return { abs, displayPath: target.displayPath };
}

async function writePdf(ctx, exec, output, pdfBytes, inputAbs) {
  const { abs } = await outputPath(ctx, exec, output, inputAbs);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(pdfBytes));
  return { output: abs, bytes: Buffer.byteLength(Buffer.from(pdfBytes)) };
}

async function loadPdf(bytes, password) {
  try {
    return await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      ...(password ? { password } : {}),
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/encrypt|password/i.test(message)) throw new Error("PDF_ENCRYPTED: PDF is encrypted or the password is missing/incorrect");
    throw error;
  }
}

async function loadPdfjs(bytes, password) {
  const opts = {
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    cMapUrl: path.join(PDFJS_ROOT, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(PDFJS_ROOT, "standard_fonts") + path.sep,
  };
  if (password) opts.password = password;
  try {
    return await pdfjs.getDocument(opts).promise;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/password|encrypt/i.test(message)) throw new Error("PDF_ENCRYPTED: PDF is encrypted or the password is missing/incorrect");
    throw error;
  }
}

function parsePages(spec, pageCount) {
  if (spec === undefined || spec === null || spec === "") return Array.from({ length: pageCount }, (_, i) => i + 1);
  const text = Array.isArray(spec) ? spec.join(",") : String(spec);
  const pages = [];
  for (const part of text.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const m = item.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`bad page selector: ${item}`);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new Error(`page selector out of range: ${item} (document has ${pageCount} pages)`);
    }
    for (let p = start; p <= end; p++) if (!pages.includes(p)) pages.push(p);
  }
  return pages;
}

function pageLabel(pages) {
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(",")}`;
}

function lineText(items) {
  return items
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((item) => item.str)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function groupTextItems(items) {
  const normalized = items
    .filter((item) => item && typeof item.str === "string" && item.str.trim())
    .map((item) => {
      const tr = Array.isArray(item.transform) ? item.transform : [];
      return {
        str: item.str,
        x: Number(tr[4]) || 0,
        y: Number(tr[5]) || 0,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
      };
    });
  const rows = [];
  for (const item of normalized) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= Math.max(2, item.height * 0.45));
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows;
}

async function pageTextItems(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const content = await page.getTextContent();
  return content.items || [];
}

async function extractPageText(doc, pageNo, layout = true) {
  const items = await pageTextItems(doc, pageNo);
  if (!layout) return items.map((i) => i.str || "").join("").trim();
  return groupTextItems(items).map((row) => lineText(row.items)).filter(Boolean).join("\n");
}

function tableFromItems(items) {
  const rows = groupTextItems(items);
  const nonEmpty = rows.filter((r) => r.items.length > 0);
  if (nonEmpty.length < 2) return null;
  const columns = [];
  for (const row of nonEmpty) {
    for (const item of row.items) {
      const column = columns.find((c) => Math.abs(c.x - item.x) <= Math.max(8, item.width * 0.8));
      if (!column) columns.push({ x: item.x, items: new Map() });
    }
  }
  columns.sort((a, b) => a.x - b.x);
  if (columns.length < 2) return null;
  const table = nonEmpty.map((row) => columns.map((col) => {
    const hit = row.items.find((item) => Math.abs(item.x - col.x) <= Math.max(8, item.width * 0.8));
    return hit ? hit.str.trim() : "";
  }));
  if (table.some((row) => row.filter(Boolean).length >= 2)) return table;
  return null;
}

async function extractTextResult(ctx, exec, args, maxChars) {
  const { bytes, target } = await readInput(ctx, exec, args.path, args.maxBytes || MAX_DEFAULT);
  const doc = await loadPdfjs(bytes, args.password);
  const pages = parsePages(args.pages, doc.numPages);
  const out = [];
  let total = 0;
  let truncated = false;
  for (const p of pages) {
    let text = await extractPageText(doc, p, args.layout !== false);
    if (!text) text = "";
    if (total + text.length > maxChars) {
      text = text.slice(0, Math.max(0, maxChars - total));
      truncated = true;
    }
    out.push({ page: p, text });
    total += text.length;
    if (truncated) break;
  }
  return {
    path: target.displayPath,
    pageCount: doc.numPages,
    pages: out,
    chars: total,
    truncated,
  };
}

async function extractTablesResult(ctx, exec, args, maxChars) {
  const { bytes, target } = await readInput(ctx, exec, args.path, args.maxBytes || MAX_DEFAULT);
  const doc = await loadPdfjs(bytes, args.password);
  const pages = parsePages(args.pages, doc.numPages);
  const tables = [];
  let total = 0;
  let truncated = false;
  for (const p of pages) {
    const items = await pageTextItems(doc, p);
    const table = tableFromItems(items);
    if (!table) continue;
    const markdown = [table[0].map((v) => v || " ").join(" | "), table[0].map(() => "---").join(" | "), ...table.slice(1).map((row) => row.map((v) => v || " ").join(" | "))].join("\n");
    if (total + markdown.length > maxChars) {
      truncated = true;
      break;
    }
    tables.push({ page: p, markdown });
    total += markdown.length;
  }
  return { path: target.displayPath, pageCount: doc.numPages, tables, truncated };
}

async function pageOps(ctx, exec, args, op) {
  const { bytes, target } = await readInput(ctx, exec, args.path, MAX_DEFAULT);
  const doc = await loadPdf(bytes, args.password);
  const total = doc.getPageCount();
  const pages = parsePages(args.pages, total);
  let result;
  if (op === "rotate") {
    const deg = Number(args.degrees);
    if (![90, 180, 270].includes(deg)) throw new Error("degrees must be 90, 180, or 270");
    for (const p of pages) doc.getPage(p - 1).setRotation(degrees((doc.getPage(p - 1).getRotation().angle + deg) % 360));
    result = await writePdf(ctx, exec, args.output, await doc.save(), ctx.fs.processPath(target));
  } else if (op === "delete") {
    for (const p of pages.slice().sort((a, b) => b - a)) doc.removePage(p - 1);
    result = await writePdf(ctx, exec, args.output, await doc.save(), ctx.fs.processPath(target));
  } else if (op === "extract") {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, pages.map((p) => p - 1));
    copied.forEach((page) => out.addPage(page));
    result = await writePdf(ctx, exec, args.output, await out.save(), ctx.fs.processPath(target));
  } else if (op === "reorder") {
    if (!Array.isArray(args.order) || args.order.length !== total || new Set(args.order).size !== total || args.order.some((n) => !Number.isInteger(n) || n < 1 || n > total)) {
      throw new Error(`order must be a permutation of 1..${total}`);
    }
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, args.order.map((p) => p - 1));
    copied.forEach((page) => out.addPage(page));
    result = await writePdf(ctx, exec, args.output, await out.save(), ctx.fs.processPath(target));
  }
  return { path: target.displayPath, operation: op, pages: pages.length, ...result };
}

async function merge(ctx, exec, args) {
  if (!Array.isArray(args.paths) || args.paths.length < 2) throw new Error("paths must contain at least two PDFs");
  const out = await PDFDocument.create();
  const sources = [];
  for (let i = 0; i < args.paths.length; i++) {
    const { bytes, target } = await readInput(ctx, exec, args.paths[i], MAX_DEFAULT);
    const src = await loadPdf(bytes, Array.isArray(args.passwords) ? args.passwords[i] : undefined);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
    sources.push(target.displayPath);
  }
  const result = await writePdf(ctx, exec, args.output, await out.save(), null);
  return { operation: "merge", sources, pages: out.getPageCount(), ...result };
}

async function split(ctx, exec, args) {
  const { bytes, target } = await readInput(ctx, exec, args.path, MAX_DEFAULT);
  const doc = await loadPdf(bytes, args.password);
  const total = doc.getPageCount();
  const ranges = args.mode === "ranges" ? [
    ...(Array.isArray(args.ranges) ? args.ranges : []),
  ] : Array.from({ length: total }, (_, i) => String(i + 1));
  if (!ranges.length) throw new Error("ranges is required when mode=ranges");
  const dirTarget = await outputPath(ctx, exec, args.output_dir || args.output, null, { mkdirs: true });
  const dir = dirTarget.abs;
  await mkdir(dir, { recursive: true });
  const base = path.basename(ctx.fs.processPath(target), path.extname(ctx.fs.processPath(target)));
  const files = [];
  for (let i = 0; i < ranges.length; i++) {
    const pages = parsePages(ranges[i], total);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, pages.map((p) => p - 1));
    copied.forEach((page) => out.addPage(page));
    const filename = `${base}-${String(i + 1).padStart(3, "0")}.pdf`;
    const file = path.join(dir, filename);
    await writeFile(file, Buffer.from(await out.save()));
    files.push(file);
  }
  return { operation: "split", path: target.displayPath, files, count: files.length };
}

async function findFont(fontPath) {
  if (fontPath) {
    const abs = path.resolve(String(fontPath));
    try { return { bytes: await readFile(abs), path: abs }; } catch { throw new Error(`font_path cannot be read: ${abs}`); }
  }
  // pdf-lib accepts a TTF/OTF byte buffer, not a TTC collection. Prefer
  // platform TTFs that cover CJK; callers can always pass font_path.
  const candidates = process.platform === "win32"
    ? ["C:\\Windows\\Fonts\\simhei.ttf", "C:\\Windows\\Fonts\\msyh.ttf", "C:\\Windows\\Fonts\\simsun.ttf"]
    : process.platform === "darwin"
      ? ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf"]
      : ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
  for (const candidate of candidates) {
    try { return { bytes: await readFile(candidate), path: candidate }; } catch { /* next */ }
  }
  return null;
}

async function watermark(ctx, exec, args) {
  const { bytes, target } = await readInput(ctx, exec, args.path, MAX_DEFAULT);
  const doc = await loadPdf(bytes, args.password);
  const pages = parsePages(args.pages, doc.getPageCount());
  let font;
  const found = await findFont(args.font_path);
  if (found) {
    try {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(found.bytes, { subset: true });
    } catch (error) {
      throw new Error(`cannot embed watermark font ${found.path}: ${error?.message ?? error}; pass a .ttf via font_path`);
    }
  } else {
    if (!/^[\x00-\x7F]*$/.test(String(args.text || "CONFIDENTIAL"))) {
      throw new Error("no CJK font found for the watermark; pass a .ttf via font_path");
    }
    font = await doc.embedFont(StandardFonts.Helvetica);
  }
  const text = String(args.text || "CONFIDENTIAL");
  const size = Math.max(8, Number(args.size) || 42);
  const opacity = Math.min(1, Math.max(0.05, Number(args.opacity) || 0.25));
  for (const p of pages) {
    const page = doc.getPage(p - 1);
    const { width, height } = page.getSize();
    page.drawText(text, {
      x: width * 0.1,
      y: height * 0.45,
      size,
      font,
      color: rgb(0.85, 0.2, 0.1),
      opacity,
      rotate: degrees(Number(args.rotation) || 35),
    });
  }
  const result = await writePdf(ctx, exec, args.output, await doc.save(), ctx.fs.processPath(target));
  return { operation: "watermark", path: target.displayPath, pages: pages.length, ...result };
}

async function formFields(ctx, exec, args) {
  const { bytes, target } = await readInput(ctx, exec, args.path, MAX_DEFAULT);
  const doc = await loadPdf(bytes, args.password);
  const form = doc.getForm();
  const fields = form.getFields().map((field) => ({
    name: field.getName(),
    type: field.constructor?.name || "field",
    value: (() => { try { return field.getText?.() ?? field.isChecked?.() ?? null; } catch { return null; } })(),
  }));
  return { path: target.displayPath, fields };
}

async function fillForm(ctx, exec, args) {
  const { bytes, target } = await readInput(ctx, exec, args.path, MAX_DEFAULT);
  const doc = await loadPdf(bytes, args.password);
  const form = doc.getForm();
  const values = args.fields && typeof args.fields === "object" ? args.fields : {};
  for (const [name, value] of Object.entries(values)) {
    const field = form.getField(name);
    if (!field) throw new Error(`form field not found: ${name}`);
    if (typeof field.setText === "function") field.setText(String(value));
    else if (typeof field.check === "function") value ? field.check() : field.uncheck();
    else throw new Error(`unsupported form field: ${name}`);
  }
  const result = await writePdf(ctx, exec, args.output, await doc.save(), ctx.fs.processPath(target));
  return { operation: "fill-form", path: target.displayPath, fields: Object.keys(values).length, ...result };
}

function toolConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  return {
    maxChars: Number(c.maxChars) > 0 ? Number(c.maxChars) : 40000,
    maxBytes: Number(c.maxBytes) > 0 ? Number(c.maxBytes) : MAX_DEFAULT,
  };
}

export function apply(ctx, config) {
  const cfg = toolConfig(config);
  const register = (tool) => ctx.tools.register(tool);

  register(rawTool(
    "pdf_info",
    "Inspect a PDF: page count, page sizes, metadata, encryption/text-layer hints. Read-only.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        password: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async (args, exec) => {
      const { bytes, target } = await readInput(ctx, exec, args.path, cfg.maxBytes);
      let doc;
      let encrypted = false;
      try {
        doc = await loadPdf(bytes, args.password);
      } catch (error) {
        if (!/PDF_ENCRYPTED/.test(String(error?.message ?? error))) throw error;
        // pdf-lib cannot decrypt. Still report page count/sizes through pdfjs
        // when a password is supplied; page mutation remains unsupported.
        encrypted = true;
      }
      let pageCount;
      let sizes = [];
      if (doc) {
        pageCount = doc.getPageCount();
        sizes = doc.getPages().map((p) => { const { width, height } = p.getSize(); return { width, height }; });
      } else {
        const js = await loadPdfjs(bytes, args.password);
        pageCount = js.numPages;
        for (let i = 1; i <= pageCount; i++) {
          const page = await js.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ width: vp.width, height: vp.height });
        }
      }
      let hasTextLayer = false;
      let textPages = 0;
      try {
        const js = await loadPdfjs(bytes, args.password);
        const sample = Math.min(js.numPages, 5);
        for (let p = 1; p <= sample; p++) {
          const text = await extractPageText(js, p, false);
          if (text.trim()) { hasTextLayer = true; textPages++; }
        }
      } catch { /* encrypted/unsupported text layer */ }
      return {
        path: target.displayPath,
        pageCount,
        pages: sizes,
        encrypted,
        hasTextLayer,
        textPagesSample: `${textPages}/${Math.min(pageCount, 5)}`,
        title: doc ? (doc.getTitle() || "") : "",
        author: doc ? (doc.getAuthor() || "") : "",
        subject: doc ? (doc.getSubject() || "") : "",
      };
    }
  ));

  register(rawTool(
    "pdf_extract_text",
    "Extract text from a PDF, preserving reading order. Supports page ranges and passwords.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string", description: "e.g. '1-3,7' or an array of page numbers" },
        password: { type: "string" },
        layout: { type: "boolean" },
        max_chars: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async (args, exec) => extractTextResult(ctx, exec, args, Math.min(Number(args.max_chars) || cfg.maxChars, cfg.maxChars))
  ));

  register(rawTool(
    "pdf_extract_tables",
    "Extract simple text tables from a PDF as Markdown. Complex merged-cell layouts are not guaranteed.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string" },
        password: { type: "string" },
        max_chars: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async (args, exec) => extractTablesResult(ctx, exec, args, Math.min(Number(args.max_chars) || cfg.maxChars, cfg.maxChars))
  ));

  register(rawTool(
    "pdf_merge",
    "Merge multiple PDFs in order into one output PDF inside the workspace.",
    {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        passwords: { type: "array", items: { type: "string" } },
        output: { type: "string" },
      },
      required: ["paths", "output"],
      additionalProperties: false,
    },
    async (args, exec) => merge(ctx, exec, args)
  ));

  register(rawTool(
    "pdf_split",
    "Split a PDF into one file per page or by ranges; output is a workspace directory.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["each", "ranges"] },
        ranges: { type: "array", items: { type: "string" } },
        output_dir: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "output_dir"],
      additionalProperties: false,
    },
    async (args, exec) => split(ctx, exec, args)
  ));

  register(rawTool(
    "pdf_extract_pages",
    "Extract selected pages into a new PDF inside the workspace.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string" },
        output: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "pages", "output"],
      additionalProperties: false,
    },
    async (args, exec) => pageOps(ctx, exec, args, "extract")
  ));

  register(rawTool(
    "pdf_delete_pages",
    "Delete selected pages and write a new PDF inside the workspace.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string" },
        output: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "pages", "output"],
      additionalProperties: false,
    },
    async (args, exec) => pageOps(ctx, exec, args, "delete")
  ));

  register(rawTool(
    "pdf_rotate",
    "Rotate selected pages by 90/180/270 degrees and write a new PDF.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string" },
        degrees: { type: "integer", enum: [90, 180, 270] },
        output: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "degrees", "output"],
      additionalProperties: false,
    },
    async (args, exec) => pageOps(ctx, exec, args, "rotate")
  ));

  register(rawTool(
    "pdf_reorder",
    "Reorder all pages using a permutation such as [3,1,2] and write a new PDF.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        order: { type: "array", items: { type: "integer" } },
        output: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "order", "output"],
      additionalProperties: false,
    },
    async (args, exec) => pageOps(ctx, exec, args, "reorder")
  ));

  register(rawTool(
    "pdf_watermark",
    "Add a text watermark to selected pages. For Chinese text, pass a .ttf font_path if no system font is found.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        text: { type: "string" },
        output: { type: "string" },
        opacity: { type: "number" },
        size: { type: "number" },
        rotation: { type: "number" },
        pages: { type: "string" },
        font_path: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "text", "output"],
      additionalProperties: false,
    },
    async (args, exec) => watermark(ctx, exec, args)
  ));

  register(rawTool(
    "pdf_form_fields",
    "List AcroForm fields and their current values in a PDF.",
    {
      type: "object",
      properties: { path: { type: "string" }, password: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async (args, exec) => formFields(ctx, exec, args)
  ));

  register(rawTool(
    "pdf_fill_form",
    "Fill AcroForm text fields/checkboxes and write a new PDF. XFA forms are not supported.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        output: { type: "string" },
        password: { type: "string" },
      },
      required: ["path", "fields", "output"],
      additionalProperties: false,
    },
    async (args, exec) => fillForm(ctx, exec, args)
  ));
}
