
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

// Wikipedia-Anfragen: mindestens 7 Sekunden Pause nach jeder Anfrage.
const WIKI_PAUSE_MS = 7000;
const WIKI_MAX_ATTEMPTS = 4;
const USER_AGENT =
  "WikiJSON/2.2 (educational Wikipedia-to-JSON project)";

// Verhindert, dass mehrere Anfragen gleichzeitig an Wikipedia gesendet werden.
let wikiRequestQueue = Promise.resolve();

// Cache für bereits geladene Artikel.
const articleCache = new Map();
const MAX_CACHE_ENTRIES = 300;

const PUBLIC_DIR = path.join(__dirname, "public");
const PUBLIC_INDEX = path.join(PUBLIC_DIR, "index.html");
const ROOT_INDEX = path.join(__dirname, "index.html");

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    "index.html fehlt. Lege sie unter public/index.html " +
    "oder direkt neben server.js ab."
  );
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    service: "Wikipedia-to-JSON",
    source: "de.wikipedia.org",
    apiPauseSeconds: WIKI_PAUSE_MS / 1000,
    cacheEntries: articleCache.size,
    queuedRequests: "sequential",
    node: process.version
  });
});

// --------------------------------------------------
// TITEL UND LINKS PRÜFEN
// --------------------------------------------------

function normalizeTitle(title) {
  return String(title || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de");
}

function parseWikipediaLink(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Der Link ist leer.");
  }

  let url;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Der Link ist keine gültige URL.");
  }

  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "de.wikipedia.org" ||
    !url.pathname.startsWith("/wiki/")
  ) {
    throw new Error(
      "Nur Links wie https://de.wikipedia.org/wiki/Artikel sind erlaubt."
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
// RETRY-AFTER AUSWERTEN
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
// ZENTRALE ANFRAGEWARTESCHLANGE
// --------------------------------------------------

/**
 * Führt eine HTTP-Anfrage an Wikipedia aus.
 *
 * Wichtig:
 * - Immer nur eine Wikipedia-Anfrage gleichzeitig.
 * - Nach jeder Anfrage mindestens 7 Sekunden Pause.
 * - Die Pause erfolgt auch, wenn fetch oder das Lesen des Bodys fehlschlägt.
 * - Alle Wikipedia-API-Aufrufe müssen diese Funktion verwenden.
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
        `[Warteschlange] Wikipedia-Anfrage beendet. ` +
        `Warte ${WIKI_PAUSE_MS / 1000} Sekunden.`
      );

      await sleep(WIKI_PAUSE_MS);
    }
  });

  // Die Warteschlange bleibt auch nach einem Fehler funktionsfähig.
  wikiRequestQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

// --------------------------------------------------
// JSON ABRUFEN UND RATE LIMITS BEHANDELN
// --------------------------------------------------

async function fetchJson(url, attempts = WIKI_MAX_ATTEMPTS) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result;

    try {
      result = await wikipediaRequest(url);
    } catch (error) {
      lastError = error;

      if (attempt >= attempts) break;

      const wait = 1000 * (2 ** (attempt - 1));

      console.warn(
        `[Netzwerk] Versuch ${attempt}/${attempts} fehlgeschlagen. ` +
        `Zusätzliche Wartezeit: ${Math.ceil(wait / 1000)} Sekunden.`
      );

      await sleep(wait);
      continue;
    }

    const retryAfter = retryAfterMilliseconds(result.retryAfter);

    // HTTP 429 = zu viele Anfragen.
    // HTTP 503 kann ebenfalls eine vorübergehende Drosselung anzeigen.
    if (result.status === 429 || result.status === 503) {
      lastError = makeError(
        `Wikipedia antwortet mit HTTP ${result.status}.`,
        result.status
      );

      if (attempt >= attempts) break;

      const wait = retryAfter !== null
        ? retryAfter
        : 5000 * (2 ** (attempt - 1));

      console.warn(
        `[Rate-Limit] HTTP ${result.status}. ` +
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
      throw new Error("Wikipedia hat kein gültiges JSON geliefert.");
    }

    if (json.error) {
      const code = json.error.code || "";
      const message =
        json.error.info || "Unbekannter Wikipedia-API-Fehler";

      if (code === "ratelimited" || code === "maxlag") {
        lastError = new Error(`${code}: ${message}`);

        if (attempt >= attempts) break;

        const wait = retryAfter !== null
          ? retryAfter
          : 5000 * (2 ** (attempt - 1));

        console.warn(
          `[Wikipedia-API] ${code}. ` +
          `Zusätzliche Wartezeit: ${Math.ceil(wait / 1000)} Sekunden.`
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
// WIKIPEDIA-API
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

function resolveAlias(title, aliases) {
  let current = title;
  const visited = new Set();

  for (let i = 0; i < 10; i++) {
    const key = normalizeTitle(current);

    if (visited.has(key)) break;

    visited.add(key);

    const next = aliases.get(key);

    if (!next) break;

    current = next;
  }

  return current;
}

/**
 * Lädt mehrere Artikel mit einer einzigen Wikipedia-API-Anfrage.
 * Maximal 10 Titel sind in einer Gruppe erlaubt.
 */
async function getArticlesBulk(titles) {
  const result = new Map();
  const uncached = new Map();

  for (const title of titles) {
    const key = normalizeTitle(title);

    if (result.has(key)) continue;

    const cached = articleCache.get(key);

    if (cached) {
      result.set(key, { article: cached });
    } else {
      uncached.set(key, title);
    }
  }

  const missingTitles = [...uncached.values()];

  // Alles bereits im Cache: kein zusätzlicher Wikipedia-Aufruf.
  if (missingTitles.length === 0) {
    return result;
  }

  const apiUrl = createApiUrl({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    maxlag: "5",
    titles: missingTitles.join("|"),
    format: "json",
    formatversion: "2"
  });

  // Zentralisierte Warteschlange und 7-Sekunden-Pause.
  const json = await fetchJson(apiUrl);

  const pages = json.query?.pages || [];
  const aliases = new Map();

  for (const entry of [
    ...(json.query?.normalized || []),
    ...(json.query?.redirects || [])
  ]) {
    aliases.set(
      normalizeTitle(entry.from),
      entry.to
    );
  }

  const pagesByTitle = new Map();

  for (const page of pages) {
    pagesByTitle.set(normalizeTitle(page.title), page);
  }

  for (const requestedTitle of missingTitles) {
    const key = normalizeTitle(requestedTitle);

    const resolvedTitle = resolveAlias(requestedTitle, aliases);

    const page =
      pagesByTitle.get(normalizeTitle(resolvedTitle)) ||
      pagesByTitle.get(key);

    if (!page || page.missing || page.invalid) {
      result.set(key, {
        error:
          `Der Wikipedia-Artikel "${requestedTitle}" wurde nicht gefunden.`
      });

      continue;
    }

    if (
      typeof page.extract !== "string" ||
      !page.extract.trim()
    ) {
      result.set(key, {
        error:
          `Der Artikel "${page.title}" enthält keinen abrufbaren Text.`
      });

      continue;
    }

    const article = {
      title: page.title,
      text: page.extract,
      url:
        "https://de.wikipedia.org/wiki/" +
        encodeURIComponent(page.title.replace(/ /g, "_"))
    };

    cacheArticle(requestedTitle, article);

    result.set(key, { article });
    result.set(normalizeTitle(page.title), { article });
  }

  return result;
}

// --------------------------------------------------
// ARTIKELTEXT BEREINIGEN
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

    // Extrem lange Sätze anhand der Wörter teilen.
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
      const text = chunk.trim();
      const key = text.toLocaleLowerCase("de");

      if (text.length < 40 || seen.has(key)) continue;

      seen.add(key);
      chunks.push(text);

      if (chunks.length >= limit) {
        return chunks;
      }
    }
  }

  // Fallback für Artikel ohne brauchbare Absatzgrenzen.
  if (chunks.length === 0 && cleaned.length >= 40) {
    return splitLongText(cleaned).slice(0, limit);
  }

  return chunks;
}

// --------------------------------------------------
// FRAGE-ANTWORT-DATEN ERZEUGEN
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
// HAUPT-API: MEHRERE WIKIPEDIA-LINKS -> JSON
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
      error: "Maximal 10 Links pro Anfrage. Bitte in Gruppen senden.",
      data: [],
      articles: []
    });
  }

  const limit = Number(maxPerArticle);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return res.status(400).json({
      error: "Die Anzahl muss zwischen 1 und 100 liegen.",
      data: [],
      articles: []
    });
  }

  const requests = urls.map(input => {
    try {
      return {
        input,
        title: parseWikipediaLink(input)
      };
    } catch (error) {
      return {
        input,
        error: error.message
      };
    }
  });

  const validTitles = requests
    .filter(item => item.title)
    .map(item => item.title);

  let retrieved = new Map();
  let bulkError = null;

  if (validTitles.length > 0) {
    try {
      retrieved = await getArticlesBulk(validTitles);
    } catch (error) {
      bulkError = error;

      console.error(
        "[Wikipedia-Bulk-Fehler]",
        error.message
      );
    }
  }

  const allExamples = [];
  const articles = [];

  for (const item of requests) {
    if (item.error) {
      articles.push({
        title: String(item.input).slice(0, 150),
        count: 0,
        error: item.error
      });

      continue;
    }

    if (bulkError) {
      articles.push({
        title: item.title,
        count: 0,
        error: bulkError.message
      });

      continue;
    }

    const entry = retrieved.get(normalizeTitle(item.title));

    if (!entry || entry.error || !entry.article) {
      articles.push({
        title: item.title,
        count: 0,
        error:
          entry?.error ||
          "Der Artikel konnte nicht geladen werden."
      });

      continue;
    }

    try {
      const article = entry.article;

      const examples = createTrainingData(
        article,
        limit
      );

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
        `[Erfolg] ${article.title}: ${examples.length} Beispiele`
      );
    } catch (error) {
      articles.push({
        title: item.title,
        count: 0,
        error: error.message
      });
    }
  }

  const data = removeDuplicateExamples(allExamples);

  const failed = articles.filter(
    item => item.error || item.count === 0
  ).length;

  if (data.length === 0) {
    return res.status(bulkError ? 503 : 422).json({
      error: bulkError
        ? "Wikipedia ist momentan nicht erreichbar oder drosselt Anfragen. " +
          "Bitte warte und versuche es erneut."
        : "Es wurden keine geeigneten Trainingsbeispiele erstellt.",
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

  console.error("[Serverfehler]", error);

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
  console.log(`Pause nach jeder API-Anfrage: ${WIKI_PAUSE_MS / 1000} Sekunden`);
  console.log("Quelle: deutsche Wikipedia-API");
  console.log("Status-Endpunkt: /api/status");
});
