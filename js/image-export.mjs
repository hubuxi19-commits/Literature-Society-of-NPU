import { formatDate, isPoetryCategory } from "./utils.mjs";

export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

const WORDMARK_URL = new URL(
  "../assets/student-literature-society-wordmark.png",
  import.meta.url,
).href;

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

export function splitExportUnits(content, category) {
  const normalized = normalizeNewlines(content);
  if (!normalized) return [];

  if (isPoetryCategory(category)) {
    return normalized.split("\n").map((text) => ({
      type: text.length ? "line" : "space",
      text,
    }));
  }

  return normalized
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ type: "paragraph", text }));
}

function findFittingCharacterCount(unit, measure, maxHeight) {
  const characters = Array.from(unit.text);
  let low = 1;
  let high = characters.length;
  let best = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const fragment = { ...unit, text: characters.slice(0, middle).join("") };
    if (measure(fragment) <= maxHeight) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best || 1;
}

export function paginateExportUnits(units, measure, maxHeight) {
  if (typeof measure !== "function") {
    throw new TypeError("measure 必须是函数");
  }
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) {
    throw new RangeError("maxHeight 必须大于零");
  }

  const pages = [];
  let page = [];
  let pageHeight = 0;

  const finishPage = () => {
    if (!page.length) return;
    pages.push(page);
    page = [];
    pageHeight = 0;
  };

  for (const originalUnit of units ?? []) {
    let unit = { ...originalUnit, text: String(originalUnit.text ?? "") };
    let unitHeight = measure(unit);

    if (unit.type === "paragraph" && unitHeight > maxHeight) {
      finishPage();
      let remaining = Array.from(unit.text);
      while (remaining.length) {
        unit = { ...unit, text: remaining.join("") };
        const fitCount = findFittingCharacterCount(unit, measure, maxHeight);
        const fragment = {
          ...unit,
          text: remaining.slice(0, fitCount).join(""),
        };
        pages.push([fragment]);
        remaining = remaining.slice(fitCount);
      }
      continue;
    }

    if (page.length && pageHeight + unitHeight > maxHeight) {
      finishPage();
    }

    page.push(unit);
    pageHeight += unitHeight;

    if (unitHeight > maxHeight) finishPage();
  }

  finishPage();
  return pages;
}

function sanitizeFilePart(value, fallback) {
  return String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f#%{}&$!'@+=`~\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || fallback;
}

export function buildExportFileName(work, pageIndex, pageCount) {
  const title = sanitizeFilePart(work?.title, "未命名作品");
  const author = sanitizeFilePart(work?.author_pen_name, "佚名");
  const pageSuffix =
    pageCount > 1 ? `-${String(pageIndex + 1).padStart(2, "0")}` : "";
  return `${title}-${author}${pageSuffix}.png`;
}

function createUnitNode(doc, unit) {
  const node = doc.createElement("div");
  node.className = `export-${unit.type}`;
  node.textContent = unit.text || "\u00a0";
  return node;
}

function createExportPage(doc, work, wordmarkUrl) {
  const page = doc.createElement("article");
  page.className = "export-page";

  const title = doc.createElement("h1");
  title.className = "export-title";
  title.textContent = String(work.title ?? "");

  const body = doc.createElement("div");
  body.className = "export-body";

  const footer = doc.createElement("footer");
  footer.className = "export-footer";

  const authorDate = doc.createElement("span");
  authorDate.className = "export-author-date";
  authorDate.textContent = `${work.author_pen_name || "佚名"} · ${formatDate(work.created_at)}`;

  const pageNumber = doc.createElement("span");
  pageNumber.className = "export-page-number";

  const wordmark = doc.createElement("img");
  wordmark.className = "export-wordmark";
  wordmark.alt = "学生文学社";
  wordmark.src = wordmarkUrl;

  footer.append(authorDate, pageNumber, wordmark);
  page.append(title, body, footer);
  return page;
}

async function blobToDataUrl(blob, win) {
  return new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), {
      once: true,
    });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function loadWordmarkDataUrl(wordmark, win) {
  if (!wordmark.complete) await wordmark.decode();
  else {
    try {
      await wordmark.decode();
    } catch {
      if (!wordmark.naturalWidth) throw new Error("文学社标识无法载入");
    }
  }

  const response = await win.fetch(wordmark.src);
  if (!response.ok) throw new Error("文学社标识无法读取");
  return blobToDataUrl(await response.blob(), win);
}

function copyComputedMarkup(source, win, wordmarkDataUrl) {
  const clone = source.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const sourceNodes = [source, ...source.querySelectorAll("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];

  sourceNodes.forEach((node, index) => {
    const computed = win.getComputedStyle(node);
    const declarations = Array.from(computed, (property) =>
      `${property}:${computed.getPropertyValue(property)};`,
    ).join("");
    cloneNodes[index].setAttribute("style", declarations);
  });

  clone.querySelector(".export-wordmark")?.setAttribute("src", wordmarkDataUrl);
  return clone;
}

async function renderPageBlob(page, wordmarkDataUrl, doc, win) {
  const clone = copyComputedMarkup(page, win, wordmarkDataUrl);
  const markup = new win.XMLSerializer().serializeToString(clone);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_WIDTH}" height="${EXPORT_HEIGHT}" viewBox="0 0 ${EXPORT_WIDTH} ${EXPORT_HEIGHT}">`,
    `<foreignObject width="${EXPORT_WIDTH}" height="${EXPORT_HEIGHT}">${markup}</foreignObject>`,
    "</svg>",
  ].join("");
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new win.Image();
  image.src = svgUrl;
  await image.decode();

  const canvas = doc.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建图片画布");
  context.drawImage(image, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 图片生成失败"));
      },
      "image/png",
    );
  });
}

async function triggerDownload(file, doc, win) {
  const url = win.URL.createObjectURL(file);
  try {
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.hidden = true;
    doc.body.append(anchor);
    anchor.click();
    await Promise.resolve();
    anchor.remove();
  } finally {
    win.URL.revokeObjectURL(url);
  }
}

function showSavePanel(files, container, doc, win) {
  container.querySelector(".export-results")?.remove();
  const panel = doc.createElement("section");
  panel.className = "export-results";
  panel.setAttribute("aria-label", "逐页保存作品图片");

  const heading = doc.createElement("h3");
  heading.textContent = "图片已经生成";
  const explanation = doc.createElement("p");
  explanation.textContent = "若浏览器拦截了连续下载，请逐页保存：";
  const actions = doc.createElement("div");
  actions.className = "export-result-actions";

  files.forEach((file, index) => {
    const button = doc.createElement("button");
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = `保存第 ${index + 1} 页`;
    button.addEventListener("click", () => triggerDownload(file, doc, win));
    actions.append(button);
  });

  panel.append(heading, explanation, actions);
  container.append(panel);
}

export async function exportWorkImages(work, options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = doc?.defaultView ?? globalThis.window;
  const nav = options.navigator ?? win?.navigator;
  if (!doc?.body || !win) throw new Error("当前环境无法生成作品图片");

  const root = doc.createElement("div");
  root.className = "export-render-root";
  root.setAttribute("aria-hidden", "true");
  doc.body.append(root);

  try {
    const firstPage = createExportPage(
      doc,
      work,
      options.wordmarkUrl ?? WORDMARK_URL,
    );
    root.append(firstPage);
    await (doc.fonts?.ready ?? Promise.resolve());

    const wordmark = firstPage.querySelector(".export-wordmark");
    const wordmarkDataUrl = await loadWordmarkDataUrl(wordmark, win);
    const measurementBody = firstPage.querySelector(".export-body");
    const maxHeight = measurementBody.getBoundingClientRect().height;
    const measure = (unit) => {
      const node = createUnitNode(doc, unit);
      measurementBody.replaceChildren(node);
      const height = node.getBoundingClientRect().height;
      measurementBody.replaceChildren();
      return height;
    };

    const units = splitExportUnits(work.content, work.category);
    const plannedPages = paginateExportUnits(units, measure, maxHeight);
    if (!plannedPages.length) plannedPages.push([]);

    const pageElements = plannedPages.map((pageUnits, pageIndex) => {
      const page =
        pageIndex === 0
          ? firstPage
          : createExportPage(doc, work, options.wordmarkUrl ?? WORDMARK_URL);
      const body = page.querySelector(".export-body");
      body.replaceChildren(...pageUnits.map((unit) => createUnitNode(doc, unit)));
      page.querySelector(".export-page-number").textContent =
        plannedPages.length > 1 ? `${pageIndex + 1} / ${plannedPages.length}` : "";
      if (pageIndex > 0) root.append(page);
      return page;
    });

    const blobs = [];
    for (const page of pageElements) {
      blobs.push(await renderPageBlob(page, wordmarkDataUrl, doc, win));
    }

    const FileConstructor = win.File ?? globalThis.File;
    const files = blobs.map(
      (blob, index) =>
        new FileConstructor(
          [blob],
          buildExportFileName(work, index, blobs.length),
          { type: "image/png" },
        ),
    );

    if (nav?.share && nav?.canShare?.({ files })) {
      try {
        await nav.share({ files, title: work.title });
        return { blobs, shared: true };
      } catch (error) {
        if (error?.name === "AbortError") {
          return { blobs, shared: false, canceled: true };
        }
      }
    }

    const resultsContainer = options.resultsContainer ?? doc.body;
    if (files.length > 1) showSavePanel(files, resultsContainer, doc, win);
    for (const file of files) await triggerDownload(file, doc, win);
    return { blobs, shared: false };
  } finally {
    root.remove();
  }
}
