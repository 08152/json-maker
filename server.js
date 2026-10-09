
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");
const PUBLIC_INDEX = path.join(PUBLIC_DIR, "index.html");
const ROOT_INDEX = path.join(__dirname, "index.html");

const USER_AGENT =
  "WikiJSON/1.0 (educational project; Node.js)";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Statische Dateien, zum Beispiel public/index.html
app.use(express.static(PUBLIC_DIR));

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

// Statuskontrolle für Render
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    service: "Wikipedia-to-JSON",
    source: "de.wikipedia.org",
    searchEngine: "Wikipedia API",
    node: process.version
  });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ruft eine JSON-Adresse mit begrenzten Wiederholungen ab.
 */
async function fetchJson(url, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
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

      if (!response.ok) {
        throw new Error(`Wikipedia antwortet mit HTTP ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") || "";

      if (
        contentType &&
        !contentType.includes("json") &&
        !contentType.includes("text/plain")
      ) {
        throw new Error("Wikipedia hat keine JSON-Antwort geliefert.");
      }

      const json = await response.json();

      if (json.error) {
        throw new Error(
          json.error.info || "Die Wikipedia-API meldet einen Fehler."
        );
      }

      return json;
    } catch (error) {
      lastError = error;

      console.warn(
        `[Wikipedia API] Versuch ${attempt}/${attempts}: ${error.message}`
      );

      if (attempt < attempts) {
        await sleep(attempt * 700);
      }
    }
  }

  throw new Error(
    `Wikipedia konnte nach ${attempts} Versuchen nicht erreicht werden: ` +
    (lastError?.message || "Unbekannter Netzwerkfehler")
  );
}

/**
 * Akzeptiert ausschließlich normale Artikel-Links
 * der deutschen Wikipedia.
 */
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
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "de.wikipedia.org" ||
    !url.pathname.startsWith("/wiki/")
  ) {
    throw new Error(
      "Nur Links wie https://de.wikipedia.org/wiki/Artikel sind erlaubt."
    );
  }

  let title;

  try {
    const encodedTitle = url.pathname
      .slice("/wiki/".length)
      .split("/")[0];

    title = decodeURIComponent(encodedTitle).replace(/_/g, " ").trim();
  } catch {
    throw new Error("Der Artikelname ist ungültig kodiert.");
  }

  if (!title || title.length > 200 || title.includes(":")) {
    throw new Error(
      "Bitte einen normalen Wikipedia-Artikel verlinken, keine Spezialseite."
    );
  }

  return title;
}

/**
 * Erstellt eine API-Adresse nur für die festgelegte Wikipedia-Domain.
 */
function createApiUrl(parameters) {
  const url = new URL("https://de.wikipedia.org/w/api.php");
  url.search = new URLSearchParams(parameters).toString();
  return url.toString();
}

/**
 * Lädt den Artikel über seinen Titel.
 * redirects=1 erlaubt Weiterleitungen innerhalb Wikipedias.
 */
async function getWikipediaArticle(requestedTitle) {
  const apiUrl = createApiUrl({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    titles: requestedTitle,
    format: "json",
    formatversion: "2"
  });

  const json = await fetchJson(apiUrl);
  const page = json.query?.pages?.[0];

  if (!page || page.missing || page.invalid) {
    throw new Error(
      `Der Wikipedia-Artikel "${requestedTitle}" wurde nicht gefunden.`
    );
  }

  if (typeof page.extract !== "string" || !page.extract.trim()) {
    throw new Error(
      `Der Artikel "${page.title}" enthält keinen abrufbaren Text.`
    );
  }

  return {
    title: page.title,
    text: page.extract,
    url:
      "https://de.wikipedia.org/wiki/" +
      encodeURIComponent(page.title.replace(/ /g, "_"))
  };
}

/**
 * Bereinigt den Artikeltext.
 */
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

/**
 * Zerlegt langen Text möglichst an Satzgrenzen.
 * Sehr lange Sätze werden notfalls anhand der Wörter geteilt.
 */
function splitLongText(text, maximumLength = 650) {
  const clean = text.trim();

  if (!clean) return [];
  if (clean.length <= maximumLength) return [clean];

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

/**
 * Bildet Textabschnitte, auch wenn Wikipedia nur einzelne
 * Zeilen statt vollständiger Absätze zurückgibt.
 */
function createTextChunks(articleText, limit) {
  const cleaned = cleanArticleText(articleText);

  if (!cleaned) return [];

  const lines = cleaned
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const blocks = [];
  let current = "";

  for (const line of lines) {
    if (
      current &&
      current.length + line.length + 1 > 550
    ) {
      blocks.push(current.trim());
      current = line;
    } else {
      current = (current + " " + line).trim();
    }
  }

  if (current) blocks.push(current.trim());

  // Fallback, wenn der Artikel keine Absatzstruktur hat.
  if (blocks.length === 0 && cleaned.length > 0) {
    blocks.push(cleaned);
  }

  const chunks = [];
  const seen = new Set();

  for (const block of blocks) {
    for (const chunk of splitLongText(block)) {
      const value = chunk.trim();
      const key = value.toLocaleLowerCase("de");

      if (value.length < 40 || seen.has(key)) continue;

      seen.add(key);
      chunks.push(value);

      if (chunks.length >= limit) {
        return chunks;
      }
    }
  }

  return chunks;
}

/**
 * Erstellt Trainingsbeispiele in genau diesem Format:
 * { "frage": "...", "antwort": "..." }
 */
function createTrainingData(article, limit) {
  const chunks = createTextChunks(article.text, limit);

  return chunks.map((chunk, index) => ({
    frage:
      `Was erfährt man über ${article.title}? ` +
      `(Textabschnitt ${index + 1})`,
    antwort: chunk
  }));
}

/**
 * Entfernt identische Frage-Antwort-Paare aus allen Artikeln.
 */
function removeDuplicateExamples(examples) {
  const seen = new Set();
  const result = [];

  for (const item of examples) {
    if (
      !item ||
      typeof item.frage !== "string" ||
      typeof item.antwort !== "string"
    ) {
      continue;
    }

    const frage = item.frage.trim();
    const antwort = item.antwort.trim();

    if (!frage || !antwort) continue;

    const key = JSON.stringify([
      frage.toLocaleLowerCase("de"),
      antwort.toLocaleLowerCase("de")
    ]);

    if (seen.has(key)) continue;

    seen.add(key);
    result.push({ frage, antwort });
  }

  return result;
}

// Wandelt eine oder mehrere Wikipedia-URLs gemeinsam um.
app.post("/api/convert", async (req, res) => {
  const body = req.body || {};
  const urls = body.urls;
  const maxPerArticle = Number(body.maxPerArticle ?? 20);

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: "Bitte mindestens einen Wikipedia-Link angeben.",
      data: [],
      articles: []
    });
  }

  if (urls.length > 10) {
    return res.status(400).json({
      error: "Maximal 10 Links pro Anfrage. Verarbeite mehrere Gruppen.",
      data: [],
      articles: []
    });
  }

  if (
    !Number.isInteger(maxPerArticle) ||
    maxPerArticle < 1 ||
    maxPerArticle > 100
  ) {
    return res.status(400).json({
      error: "maxPerArticle muss eine Zahl zwischen 1 und 100 sein.",
      data: [],
      articles: []
    });
  }

  const allExamples = [];
  const articles = [];

  // Nacheinander abrufen, damit nicht zu viele Anfragen gleichzeitig
  // an Wikipedia geschickt werden.
  for (const input of urls) {
    let requestedTitle = String(input || "").slice(0, 200);

    try {
      requestedTitle = parseWikipediaLink(input);

      console.log(
        `[Verarbeitung] Wikipedia-Artikel angefragt: ${requestedTitle}`
      );

      const article = await getWikipediaArticle(requestedTitle);

      const examples = createTrainingData(
        article,
        maxPerArticle
      );

      allExamples.push(...examples);

      articles.push({
        title: article.title,
        url: article.url,
        count: examples.length,
        error: examples.length === 0
          ? "Es konnten keine geeigneten Textabschnitte erstellt werden."
          : null
      });

      console.log(
        `[Erfolg] ${article.title}: ${examples.length} Beispiele`
      );
    } catch (error) {
      const message = error?.message || "Unbekannter Fehler";

      console.error(
        `[Artikel-Fehler] ${requestedTitle}: ${message}`
      );

      articles.push({
        title: requestedTitle,
        count: 0,
        error: message
      });
    }
  }

  const data = removeDuplicateExamples(allExamples);

  // Auch bei einem Teilerfolg erfolgreiche Beispiele zurückgeben.
  if (data.length === 0) {
    return res.status(422).json({
      error:
        "Es wurden keine Trainingsbeispiele erstellt. " +
        "Prüfe die Artikel-Links und die Render-Logs.",
      data: [],
      articles,
      total: 0,
      failed: articles.filter(
        article => article.error
      ).length
    });
  }

  return res.json({
    data,
    articles,
    total: data.length,
    failed: articles.filter(
      article => article.error
    ).length
  });
});

// Ungültiges JSON im Request verständlich beantworten.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      error: "Die gesendeten Daten sind kein gültiges JSON."
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log("JSON-Konverter ist bereit.");
  console.log("Quelle: deutsche Wikipedia-API");
  console.log("Status: /api/status");
});
