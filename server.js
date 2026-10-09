
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const WIKI_PAUSE_MS = 7000;
const MAX_RETRIES = 4;
const MAX_CACHE_ENTRIES = 300;

const USER_AGENT =
  "WikiJSON/3.0 (educational Wikipedia-to-JSON project)";

const PUBLIC_DIR = path.join(__dirname, "public");
const PUBLIC_INDEX = path.join(PUBLIC_DIR, "index.html");
const ROOT_INDEX = path.join(__dirname, "index.html");

// Gemeinsame Warteschlange für alle Wikipedia-Anfragen.
let wikiRequestQueue = Promise.resolve();

// Cache speichert erfolgreich geladene Artikel.
const articleCache = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de");
}

function makeError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// --------------------------------------------------
// STARTSEITE UND STATUS
// --------------------------------------------------

app.get("/", (req, res) => {
  if (fs.existsSync(PUBLIC_INDEX)) {
    return res.sendFile(PUBLIC_INDEX);
  }

  if (fs.existsSync(ROOT_INDEX)) {
    return res.sendFile(ROOT_INDEX);
  }

  return res.status(500).send(
    "index.html fehlt. Erstelle public/index.html " +
    "oder lege index.html neben server.js."
  );
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    service: "Wikipedia-to-JSON",
    source: "de.wikipedia.org",
    pauseBetweenRequestsSeconds: WIKI_PAUSE_MS / 1000,
    requestMode: "one-article-per-request",
    cacheEntries: articleCache.size,
    node: process.version
  });
});

// --------------------------------------------------
// WIKIPEDIA-LINKS PRÜFEN
// --------------------------------------------------

function parseWikipediaLink(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Der Link ist leer.");
  }

  let url;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Ungültiger Link.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "de.wikipedia.org" ||
    !url.pathname.startsWith("/wiki/")
  ) {
    throw new Error(
      "Nur deutsche Wikipedia-Artikellinks sind erlaubt."
    );
  }

  let title;

  try {
    title = decodeURIComponent(
      url.pathname.slice("/wiki/".length).split("/")[0]
    ).replace(/_/g, " ").trim();
  } catch {
    throw new Error("Der Artikelname ist ungültig kodiert.");
  }

  if (!title || title.length > 200 || title.includes(":")) {
    throw new Error(
      "Bitte einen normalen Wikipedia-Artikel verlinken."
    );
  }

  return title;
}

// --------------------------------------------------
// RETRY-AFTER AUSLESEN
// --------------------------------------------------

function retryAfterMilliseconds(value) {
  if (!value) return null;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

// --------------------------------------------------
// EINZELNE WIKIPEDIA-ANFRAGE
// --------------------------------------------------

/*
 * Diese Funktion stellt sicher, dass Wikipedia-Anfragen
 * nacheinander ausgeführt werden.
 *
 * Nach jeder HTTP-Anfrage wartet sie 7 Sekunden.
 * Das gilt auch bei fehlgeschlagenen Anfragen.
 *
 * Es wird hier immer nur EIN Artikel pro API-Anfrage geladen.
 */
function wikipediaRequest(url) {
  const task = wikiRequestQueue.then(async () => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Accept-Language": "de-DE,de;q=0.9"
        },
        signal: AbortSignal.timeout(20000),
        redirect: "follow"
      });

      const body = await response.text();

      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body
      };
    } finally {
      console.log(
        `[PAUSE] Anfrage abgeschlossen. ` +
        `Nächste Wikipedia-Anfrage frühestens nach ${WIKI_PAUSE_MS / 1000} Sekunden.`
      );

      await sleep(WIKI_PAUSE_MS);
    }
  });

  // Ein Fehler darf die Warteschlange nicht dauerhaft blockieren.
  wikiRequestQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

// --------------------------------------------------
// HTTP-429 UND NETZWERKFEHLER BEHANDELN
// --------------------------------------------------

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let result;

    try {
      result = await wikipediaRequest(url);
    } catch (error) {
      lastError = error;

      if (attempt >= MAX_RETRIES) {
        break;
      }

      const wait = 1000 * (2 ** (attempt - 1));

      console.warn(
        `[NETZWERK] Versuch ${attempt}/${MAX_RETRIES}. ` +
        `Zusätzliche Wartezeit: ${Math.ceil(wait / 1000)} Sekunden.`
      );

      await sleep(wait);
      continue;
    }

    const retryAfter = retryAfterMilliseconds(result.retryAfter);

    if (result.status === 429 || result.status === 503) {
      lastError = makeError(
        `Wikipedia antwortet mit HTTP ${result.status}.`,
        result.status
      );

      if (attempt >= MAX_RETRIES) {
        break;
      }

      const wait = retryAfter !== null
        ? retryAfter
        : 5000 * (2 ** (attempt - 1));

      console.warn(
        `[RATE LIMIT] HTTP ${result.status}. ` +
        `Zusätzliche Wartezeit: ${Math.ceil(wait / 1000)} Sekunden.`
      );

      await sleep(wait);
      continue;
    }

    if (result.status < 200 || result.status >= 300) {
      throw makeError(
        `Wikipedia antwortet mit HTTP ${result.status}.`,
        result.status
      );
    }

    let json;

    try {
      json = JSON.parse(result.body);
    } catch {
      throw new Error("Wikipedia lieferte kein gültiges JSON.");
    }

    if (json.error) {
      const code = json.error.code || "";
      const message =
        json.error.info || "Unbekannter Wikipedia-API-Fehler";

      if (code === "ratelimited" || code === "maxlag") {
        lastError = new Error(`${code}: ${message}`);

        if (attempt >= MAX_RETRIES) {
          break;
        }

        const wait = retryAfter !== null
          ? retryAfter
          : 5000 * (2 ** (attempt - 1));

        console.warn(
          `[WIKIPEDIA API] ${code}. Warte zusätzlich ` +
          `${Math.ceil(wait / 1000)} Sekunden.`
        );

        await sleep(wait);
        continue;
      }

      throw new Error(`Wikipedia-API: ${message}`);
    }

    return json;
  }

  throw new Error(
    `Wikipedia konnte nach mehreren Versuchen nicht antworten: ` +
    (lastError?.message || "Unbekannter Fehler")
  );
}

// --------------------------------------------------
// EINEN ARTIKEL LADEN
// --------------------------------------------------

function createApiUrl(parameters) {
  const url = new URL("https://de.wikipedia.org/w/api.php");

  url.search = new URLSearchParams(parameters).toString();

  return url.toString();
}

function cacheArticle(requestedTitle, article) {
  const keys = [
    normalizeTitle(requestedTitle),
    normalizeTitle(article.title)
  ];

  for (const key of keys) {
    articleCache.delete(key);
    articleCache.set(key, article);
  }

  while (articleCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = articleCache.keys().next().value;
    articleCache.delete(oldestKey);
  }
}

async function getWikipediaArticle(title) {
  const cacheKey = normalizeTitle(title);
  const cached = articleCache.get(cacheKey);

  if (cached) {
    // Ein Cache-Treffer erzeugt keine neue Wikipedia-Anfrage.
    console.log(`[CACHE] ${cached.title}`);
    return cached;
  }

  const apiUrl = createApiUrl({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    maxlag: "5",
    titles: title,
    format: "json",
    formatversion: "2"
  });

  console.log(`[ANFRAGE] Lade einzelnen Artikel: ${title}`);

  // Wichtig: nur EIN Titel in dieser Anfrage.
  const json = await fetchJson(apiUrl);
  const page = json.query?.pages?.[0];

  if (!page || page.missing || page.invalid) {
    throw new Error(`Artikel "${title}" wurde nicht gefunden.`);
  }

  if (
    typeof page.extract !== "string" ||
    !page.extract.trim()
  ) {
    throw new Error(
      `Der Artikel "${page.title}" enthält keinen abrufbaren Text.`
    );
  }

  const article = {
    title: page.title,
    text: page.extract,
    url:
      "https://de.wikipedia.org/wiki/" +
      encodeURIComponent(page.title.replace(/ /g, "_"))
  };

  cacheArticle(title, article);

  console.log(`[ERFOLG] ${article.title}`);

  return article;
}

// --------------------------------------------------
// TEXT BEREINIGEN UND AUFTEILEN
// --------------------------------------------------

function cleanArticleText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\[\s*\d+\s*\]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongText(text, maximumLength = 650) {
  const clean = text.trim();

  if (!clean) return [];

  if (clean.length <= maximumLength) {
    return [clean];
  }

  const sentences =
    clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean];

  const chunks = [];
  let current = "";

  function flush() {
    const value = current.trim();

    if (value.length >= 40) {
      chunks.push(value);
    }

    current = "";
  }

  for (const sentence of sentences) {
    const part = sentence.trim();

    if (!part) continue;

    // Sehr lange Sätze anhand der Wörter aufteilen.
    if (part.length > maximumLength) {
      flush();

      const words = part.split(/\s+/);
      let wordChunk = "";

      for (const word of words) {
        if (
          wordChunk &&
          (wordChunk + " " + word).length > maximumLength
        ) {
          if (wordChunk.trim().length >= 40) {
            chunks.push(wordChunk.trim());
          }

          wordChunk = word;
        } else {
          wordChunk = (wordChunk + " " + word).trim();
        }
      }

      if (wordChunk.trim().length >= 40) {
        chunks.push(wordChunk.trim());
      }

      continue;
    }

    if (
      current &&
      (current + " " + part).length > maximumLength
    ) {
      flush();
      current = part;
    } else {
      current = (current + " " + part).trim();
    }
  }

  flush();

  return chunks;
}

function createTextChunks(articleText, limit) {
  const cleaned = cleanArticleText(articleText);

  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);

  const chunks = [];
  const seen = new Set();

  for (const paragraph of paragraphs) {
    for (const chunk of splitLongText(paragraph)) {
      const value = chunk.trim();
      const key = value.toLocaleLowerCase("de");

      if (value.length < 40 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      chunks.push(value);

      if (chunks.length >= limit) {
        return chunks;
      }
    }
  }

  if (chunks.length === 0 && cleaned.length >= 40) {
    return splitLongText(cleaned).slice(0, limit);
  }

  return chunks;
}

// --------------------------------------------------
// FRAGE-ANTWORT-PAARE ERZEUGEN
// --------------------------------------------------

function createTrainingData(article, limit) {
  const chunks = createTextChunks(article.text, limit);

  return chunks.map((chunk, index) => ({
    frage:
      `Was erfährt man über ${article.title}? ` +
      `(Textabschnitt ${index + 1})`,
    antwort: chunk
  }));
}

function removeDuplicateExamples(examples) {
  const seen = new Set();
  const result = [];

  for (const item of examples) {
    const frage = String(item.frage || "").trim();
    const antwort = String(item.antwort || "").trim();

    if (!frage || !antwort) continue;

    const key = JSON.stringify([
      frage.toLocaleLowerCase("de"),
      antwort.toLocaleLowerCase("de")
    ]);

    if (seen.has(key)) continue;

    seen.add(key);

    result.push({
      frage,
      antwort
    });
  }

  return result;
}

// --------------------------------------------------
// MEHRERE LINKS VERARBEITEN: EINZELN UND NACHEINANDER
// --------------------------------------------------

app.post("/api/convert", async (req, res) => {
  const { urls, maxPerArticle = 20 } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: "Bitte mindestens einen Wikipedia-Link eingeben.",
      data: [],
      articles: []
    });
  }

  if (urls.length > 10) {
    return res.status(400).json({
      error:
        "Maximal 10 Links pro Anfrage. " +
        "Die Links werden trotzdem einzeln abgefragt.",
      data: [],
      articles: []
    });
  }

  const limit = Number(maxPerArticle);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({
      error: "Beispiele pro Artikel müssen zwischen 1 und 100 liegen.",
      data: [],
      articles: []
    });
  }

  const allExamples = [];
  const articles = [];

  // JEDER Link wird einzeln verarbeitet.
  // getWikipediaArticle wartet nach seiner HTTP-Anfrage 7 Sekunden.
  for (let index = 0; index < urls.length; index++) {
    const input = urls[index];

    let title;

    try {
      title = parseWikipediaLink(input);

      console.log(
        `[FORTSCHRITT] Link ${index + 1} von ${urls.length}: ${title}`
      );

      const article = await getWikipediaArticle(title);
      const examples = createTrainingData(article, limit);

      allExamples.push(...examples);

      articles.push({
        title: article.title,
        url: article.url,
        count: examples.length,
        error: examples.length
          ? null
          : "Keine geeigneten Textabschnitte gefunden."
      });

      console.log(
        `[FERTIG] ${index + 1}/${urls.length}: ` +
        `${article.title}, ${examples.length} Beispiele`
      );
    } catch (error) {
      const message = error?.message || "Unbekannter Fehler";

      console.error(
        `[ARTIKEL-FEHLER] Link ${index + 1}: ${message}`
      );

      articles.push({
        title: title || String(input).slice(0, 150),
        count: 0,
        error: message
      });
    }
  }

  const data = removeDuplicateExamples(allExamples);

  const failed = articles.filter(
    article => article.error || article.count === 0
  ).length;

  if (data.length === 0) {
    return res.status(422).json({
      error:
        "Es wurden keine Trainingsbeispiele erstellt. " +
        "Prüfe die Links und die Render-Logs.",
      data: [],
      articles,
      total: 0,
      failed
    });
  }

  return res.json({
    data,
    articles,
    total: data.length,
    failed
  });
});

// --------------------------------------------------
// FEHLERBEHANDLUNG
// --------------------------------------------------

app.use((error, req, res, next) => {
  if (
    error instanceof SyntaxError &&
    Object.prototype.hasOwnProperty.call(error, "body")
  ) {
    return res.status(400).json({
      error: "Die Anfrage enthält kein gültiges JSON."
    });
  }

  console.error("[SERVERFEHLER]", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "Interner Serverfehler. Prüfe die Render-Logs."
  });
});

// --------------------------------------------------
// SERVER STARTEN
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log("Wikipedia-JSON-Konverter ist bereit.");
  console.log("Anfragen: ein Artikel pro Wikipedia-API-Aufruf.");
  console.log("Pause nach jeder HTTP-Anfrage: 7 Sekunden.");
  console.log("Status: /api/status");
});
