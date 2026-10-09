
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_PUBLIC = path.join(PUBLIC_DIR, "index.html");
const INDEX_ROOT = path.join(__dirname, "index.html");

const USER_AGENT =
  "Mozilla/5.0 (compatible; WikiJSONEducationalBot/1.0)";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  if (fs.existsSync(INDEX_PUBLIC)) {
    return res.sendFile(INDEX_PUBLIC);
  }

  if (fs.existsSync(INDEX_ROOT)) {
    return res.sendFile(INDEX_ROOT);
  }

  res.status(500).send(
    "index.html fehlt. Lege die Datei in public/ oder in den Hauptordner."
  );
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    searchEngine: "DuckDuckGo",
    source: "de.wikipedia.org"
  });
});

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|sup|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\[\s*\d+\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWikipediaInput(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("Ungültiger Link.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "de.wikipedia.org" ||
    !url.pathname.startsWith("/wiki/")
  ) {
    throw new Error(
      "Nur Links von https://de.wikipedia.org/wiki/... sind erlaubt."
    );
  }

  let title;

  try {
    title = decodeURIComponent(
      url.pathname.slice("/wiki/".length).split("/")[0]
    ).replace(/_/g, " ");
  } catch {
    throw new Error("Der Artikelname im Link ist ungültig.");
  }

  if (!title || title.includes(":") || title.length > 200) {
    throw new Error("Bitte einen normalen Wikipedia-Artikel verwenden.");
  }

  return title.trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .trim()
    .toLocaleLowerCase("de");
}

function isWikipediaArticle(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname === "de.wikipedia.org" &&
      url.pathname.startsWith("/wiki/") &&
      !decodeURIComponent(url.pathname.slice(6)).includes(":")
    );
  } catch {
    return false;
  }
}

async function fetchText(url, timeout = 15000) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/json",
      "Accept-Language": "de-DE,de;q=0.9"
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} beim Abrufen.`);
  }

  return {
    text: await response.text(),
    url: response.url
  };
}

function unwrapDuckDuckGoLink(href) {
  try {
    const url = new URL(
      decodeHtml(href),
      "https://html.duckduckgo.com"
    );

    if (
      url.hostname === "duckduckgo.com" ||
      url.hostname.endsWith(".duckduckgo.com")
    ) {
      const destination = url.searchParams.get("uddg");
      if (destination) return destination;
    }

    return url.href;
  } catch {
    return "";
  }
}

async function searchWikipediaWithDuckDuckGo(title) {
  const searchUrl = new URL("https://html.duckduckgo.com/html/");

  searchUrl.searchParams.set(
    "q",
    `site:de.wikipedia.org/wiki "${title}"`
  );

  const result = await fetchText(searchUrl.toString());

  const anchors = [
    ...result.text.matchAll(
      /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
    )
  ];

  const candidates = [];

  for (const match of anchors) {
    const attributes = match[1];

    const classMatch = attributes.match(
      /\bclass=["']([^"']*)["']/i
    );

    if (!classMatch || !/\bresult__a\b/.test(classMatch[1])) {
      continue;
    }

    const hrefMatch = attributes.match(
      /\bhref=["']([^"']+)["']/i
    );

    if (!hrefMatch) continue;

    const target = unwrapDuckDuckGoLink(hrefMatch[1]);

    if (!isWikipediaArticle(target)) continue;

    const targetUrl = new URL(target);
    const targetTitle = decodeURIComponent(
      targetUrl.pathname.slice("/wiki/".length)
    );

    candidates.push({
      url: targetUrl.origin + targetUrl.pathname,
      title: targetTitle
    });
  }

  const unique = [
    ...new Map(candidates.map(item => [item.url, item])).values()
  ];

  if (!unique.length) {
    throw new Error(
      "DuckDuckGo lieferte keinen Wikipedia-Link. " +
      "Die Suche könnte blockiert sein oder keine Ergebnisse haben."
    );
  }

  const exact = unique.find(
    item => normalizeTitle(item.title) === normalizeTitle(title)
  );

  // Exakten Treffer bevorzugen; andernfalls besten Suchtreffer verwenden.
  return exact || unique[0];
}

async function fetchWikipediaArticle(url) {
  if (!isWikipediaArticle(url)) {
    throw new Error("Der gefundene Link ist kein erlaubter Wikipedia-Link.");
  }

  const result = await fetchText(url);

  // Nach Weiterleitungen nochmals die Domain kontrollieren.
  if (!isWikipediaArticle(result.url)) {
    throw new Error("Wikipedia hat auf eine nicht erlaubte Adresse verwiesen.");
  }

  const html = result.text;

  const headingMatch = html.match(
    /<h1\b[^>]*id=["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/i
  );

  const title = headingMatch
    ? htmlToText(headingMatch[1])
    : decodeURIComponent(new URL(result.url).pathname.slice(6))
        .replace(/_/g, " ");

  const start = html.search(/id=["']mw-content-text["']/i);

  if (start < 0) {
    throw new Error("Der Wikipedia-Artikeltext konnte nicht gefunden werden.");
  }

  let content = html.slice(start);

  const end = content.search(
    /id=["']catlinks["']|class=["'][^"']*printfooter/i
  );

  if (end >= 0) content = content.slice(0, end);

  return {
    title,
    url: result.url,
    content
  };
}

function splitLongText(text, maximum = 700) {
  if (text.length <= maximum) return [text];

  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;

    if (current && (current + " " + part).length > maximum) {
      if (current.length >= 60) chunks.push(current.trim());
      current = part;
    } else {
      current = (current + " " + part).trim();
    }
  }

  if (current.length >= 60) chunks.push(current.trim());

  return chunks;
}

function extractExamples(title, content, limit) {
  const blocks = [];
  const regex =
    /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>|<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;

  let currentSection = "Einleitung";
  let excludedLevel = null;
  let match;

  const excludedHeadings = new Set([
    "einzelnachweise",
    "literatur",
    "weblinks",
    "externe links",
    "quellen",
    "anmerkungen",
    "siehe auch"
  ]);

  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      const level = Number(match[1]);
      const heading = htmlToText(match[2]);

      if (excludedLevel !== null && level <= excludedLevel) {
        excludedLevel = null;
      }

      if (excludedLevel !== null) continue;

      if (excludedHeadings.has(heading.toLocaleLowerCase("de"))) {
        excludedLevel = level;
        continue;
      }

      if (heading) currentSection = heading;
      continue;
    }

    if (excludedLevel !== null) continue;

    const paragraph = htmlToText(match[3]);

    if (paragraph.length < 60) continue;

    for (const chunk of splitLongText(paragraph)) {
      blocks.push({
        section: currentSection,
        text: chunk
      });

      if (blocks.length >= limit) return buildData(title, blocks);
    }
  }

  return buildData(title, blocks);
}

function buildData(title, blocks) {
  return blocks.map((block, index) => ({
    frage:
      `Was steht im Abschnitt „${block.section}“ ` +
      `des Wikipedia-Artikels „${title}“ (Textabschnitt ${index + 1})?`,
    antwort: block.text
  }));
}

app.post("/api/convert", async (req, res) => {
  const { urls, maxPerArticle = 20 } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: "Bitte mindestens einen Wikipedia-Link angeben."
    });
  }

  if (urls.length > 10) {
    return res.status(400).json({
      error: "Maximal 10 Links pro Anfrage."
    });
  }

  const limit = Number(maxPerArticle);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({
      error: "Die Anzahl muss zwischen 1 und 100 liegen."
    });
  }

  const data = [];
  const articles = [];

  for (const input of urls) {
    try {
      const requestedTitle = parseWikipediaInput(input);

      // 1. Artikel über DuckDuckGo suchen.
      const found = await searchWikipediaWithDuckDuckGo(requestedTitle);

      // 2. Den gefundenen Wikipedia-Artikel abrufen.
      const article = await fetchWikipediaArticle(found.url);

      // 3. Artikeltext in Frage-Antwort-Datensätze umwandeln.
      const examples = extractExamples(
        article.title,
        article.content,
        limit
      );

      data.push(...examples);

      articles.push({
        title: article.title,
        url: article.url,
        count: examples.length
      });

      console.log(
        `DuckDuckGo → Wikipedia: ${article.title} (${examples.length} Beispiele)`
      );
    } catch (error) {
      articles.push({
        title: String(input).slice(0, 150),
        count: 0,
        error: error.message
      });

      console.error("Artikel konnte nicht verarbeitet werden:", error.message);
    }
  }

  if (data.length === 0) {
    return res.status(422).json({
      error:
        "Keine Trainingsdaten erstellt. Prüfe die Links und die Render-Logs.",
      articles
    });
  }

  res.json({ data, articles });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log("Suchdienst: DuckDuckGo");
  console.log("Erlaubte Quelle: de.wikipedia.org");
});
