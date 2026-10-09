
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_PUBLIC = path.join(PUBLIC_DIR, "index.html");
const INDEX_ROOT = path.join(__dirname, "index.html");

const USER_AGENT =
  "Mozilla/5.0 (compatible; WikiJSON/2.0; educational project)";

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
    "index.html fehlt. Erstelle public/index.html oder lege index.html in den Hauptordner."
  );
});

async function fetchResponse(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/json",
      "Accept-Language": "de-DE,de;q=0.9"
    },
    signal: AbortSignal.timeout(12000),
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return {
    text: await response.text(),
    url: response.url
  };
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de");
}

function getTitleFromWikipediaUrl(input) {
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
      "Erlaubt sind nur Links wie https://de.wikipedia.org/wiki/Artikel"
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

  return title;
}

function isAllowedWikipediaUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "de.wikipedia.org" ||
      !url.pathname.startsWith("/wiki/")
    ) {
      return false;
    }

    const title = decodeURIComponent(
      url.pathname.slice("/wiki/".length)
    );

    return Boolean(title) && !title.includes(":");
  } catch {
    return false;
  }
}

function unwrapDuckDuckGoLink(href) {
  try {
    const url = new URL(
      decodeEntities(href),
      "https://html.duckduckgo.com"
    );

    if (
      url.hostname === "duckduckgo.com" ||
      url.hostname.endsWith(".duckduckgo.com")
    ) {
      const destination = url.searchParams.get("uddg");

      if (destination) {
        return new URL(destination).href;
      }
    }

    return url.href;
  } catch {
    return "";
  }
}

function extractDuckDuckGoLinks(html) {
  const results = [];
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

  for (const anchor of anchors) {
    const hrefMatch = anchor.match(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
    );

    if (!hrefMatch) continue;

    const href = hrefMatch[1] || hrefMatch[2] || hrefMatch[3];
    const target = unwrapDuckDuckGoLink(href);

    if (!isAllowedWikipediaUrl(target)) continue;

    let title;

    try {
      title = decodeURIComponent(
        new URL(target).pathname.slice("/wiki/".length)
      ).replace(/_/g, " ");
    } catch {
      continue;
    }

    results.push({
      title,
      url: "https://de.wikipedia.org/wiki/" +
        encodeURIComponent(title.replace(/ /g, "_"))
    });
  }

  return [
    ...new Map(results.map(item => [item.url, item])).values()
  ];
}

async function searchDuckDuckGo(title) {
  const endpoints = [
    "https://html.duckduckgo.com/html/",
    "https://lite.duckduckgo.com/lite/"
  ];

  const query = `site:de.wikipedia.org/wiki ${title}`;

  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);

      const result = await fetchResponse(url.href);
      const links = extractDuckDuckGoLinks(result.text);

      if (links.length > 0) {
        const exact = links.find(
          item => normalizeTitle(item.title) === normalizeTitle(title)
        );

        const selected = exact || links[0];

        console.log(
          `[DuckDuckGo] ${title} -> ${selected.title}`
        );

        return {
          ...selected,
          searchSource: "DuckDuckGo"
        };
      }

      console.log(
        `[DuckDuckGo] Keine Treffer über ${endpoint}`
      );
    } catch (error) {
      console.log(
        `[DuckDuckGo] Suche fehlgeschlagen: ${error.message}`
      );
    }
  }

  return null;
}

async function searchWikipediaApi(title) {
  const url = new URL("https://de.wikipedia.org/w/api.php");

  url.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: title,
    srnamespace: "0",
    srlimit: "5",
    format: "json",
    formatversion: "2"
  }).toString();

  const result = await fetchResponse(url.href);
  const json = JSON.parse(result.text);
  const pages = json.query?.search || [];

  if (!pages.length) {
    throw new Error(
      "Weder DuckDuckGo noch die Wikipedia-Suche fanden einen Artikel."
    );
  }

  const exact = pages.find(
    page => normalizeTitle(page.title) === normalizeTitle(title)
  );

  const page = exact || pages[0];

  console.log(
    `[Wikipedia-Fallback] ${title} -> ${page.title}`
  );

  return {
    title: page.title,
    url: "https://de.wikipedia.org/wiki/" +
      encodeURIComponent(page.title.replace(/ /g, "_")),
    searchSource: "Wikipedia-API-Fallback"
  };
}

async function resolveArticle(title) {
  const ddgResult = await searchDuckDuckGo(title);

  if (ddgResult) {
    return ddgResult;
  }

  console.log(
    `[Suche] DuckDuckGo lieferte keine auswertbaren Treffer für "${title}".`
  );

  return searchWikipediaApi(title);
}

async function getArticleText(title) {
  const url = new URL("https://de.wikipedia.org/w/api.php");

  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2"
  }).toString();

  const result = await fetchResponse(url.href);
  const json = JSON.parse(result.text);
  const page = json.query?.pages?.[0];

  if (!page || page.missing || !page.extract) {
    throw new Error(
      `Der Artikel "${title}" hat keinen abrufbaren Text.`
    );
  }

  return {
    title: page.title,
    text: page.extract
  };
}

function splitLongParagraph(text, maxLength = 650) {
  if (text.length <= maxLength) {
    return [text];
  }

  const sentences =
    text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const part = sentence.trim();

    if (!part) continue;

    if (
      current &&
      (current + " " + part).length > maxLength
    ) {
      if (current.length >= 60) {
        chunks.push(current.trim());
      }

      current = part;
    } else {
      current = (current + " " + part).trim();
    }
  }

  if (current.length >= 60) {
    chunks.push(current.trim());
  }

  return chunks;
}

function createTrainingData(title, articleText, limit) {
  const paragraphs = articleText
    .replace(/\[\d+\]/g, "")
    .split(/\n+/)
    .map(text => text.replace(/\s+/g, " ").trim())
    .filter(text => text.length >= 60);

  const result = [];
  const seen = new Set();

  for (const paragraph of paragraphs) {
    const chunks = splitLongParagraph(paragraph);

    for (const chunk of chunks) {
      const key = chunk.toLocaleLowerCase("de");

      if (seen.has(key)) continue;
      seen.add(key);

      result.push({
        frage:
          `Was erfährt man über ${title}? ` +
          `(Abschnitt ${result.length + 1})`,
        antwort: chunk
      });

      if (result.length >= limit) {
        return result;
      }
    }
  }

  return result;
}

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    service: "Wikipedia-to-JSON",
    primarySearch: "DuckDuckGo",
    fallbackSearch: "Wikipedia API"
  });
});

app.post("/api/convert", async (req, res) => {
  const { urls, maxPerArticle = 20 } = req.body || {};

  if (!Array.isArray(urls) || urls.length < 1) {
    return res.status(400).json({
      error: "Gib mindestens einen Wikipedia-Link ein."
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
      const requestedTitle = getTitleFromWikipediaUrl(input);

      // Erst DuckDuckGo, dann bei Bedarf Wikipedia als Such-Fallback.
      const found = await resolveArticle(requestedTitle);

      // Den Text immer über die Wikipedia-API abrufen.
      const article = await getArticleText(found.title);

      const examples = createTrainingData(
        article.title,
        article.text,
        limit
      );

      data.push(...examples);

      articles.push({
        title: article.title,
        url: found.url,
        searchSource: found.searchSource,
        count: examples.length
      });

      console.log(
        `[Fertig] ${article.title}: ${examples.length} Beispiele`
      );
    } catch (error) {
      console.error(
        `[Fehler] ${String(input)}: ${error.message}`
      );

      articles.push({
        title: String(input).slice(0, 150),
        count: 0,
        error: error.message
      });
    }
  }

  if (data.length === 0) {
    return res.status(422).json({
      error:
        "Es wurden keine Trainingsbeispiele erstellt. " +
        "Prüfe die Links und die Render-Logs.",
      articles
    });
  }

  res.json({
    data,
    articles
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log("Primäre Suche: DuckDuckGo");
  console.log("Fallback: Wikipedia-Such-API");
});
