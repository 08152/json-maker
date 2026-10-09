
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseWikipediaUrl(input) {
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
    throw new Error("Nur deutsche Wikipedia-Artikellinks sind erlaubt.");
  }

  const title = decodeURIComponent(
    url.pathname.slice("/wiki/".length)
  ).split("/")[0];

  if (
    !title ||
    title.includes(":") ||
    title.length > 200
  ) {
    throw new Error("Bitte einen normalen Artikel-Link verwenden.");
  }

  return title;
}

async function getArticle(title) {
  const api = new URL("https://de.wikipedia.org/w/api.php");

  api.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    format: "json",
    formatversion: "2",
    titles: title
  }).toString();

  const response = await fetch(api, {
    headers: {
      "User-Agent": "WikiToJSON/1.0 (educational project)"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error("Wikipedia-API antwortet mit HTTP " + response.status);
  }

  const json = await response.json();
  const page = json.query?.pages?.[0];

  if (!page || page.missing || !page.extract) {
    throw new Error("Artikel nicht gefunden oder ohne Text.");
  }

  return {
    title: page.title,
    text: page.extract
  };
}

function makeExamples(title, text, limit) {
  const clean = text
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Absätze und Sätze werden zu kurzen, überprüfbaren Textstücken.
  const paragraphs = clean
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => p.length >= 80);

  const chunks = [];

  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];

    let current = "";

    for (const sentence of sentences) {
      const s = sentence.trim();
      if (s.length < 25) continue;

      if ((current + " " + s).trim().length > 650) {
        if (current.length >= 80) chunks.push(current.trim());
        current = s;
      } else {
        current = (current + " " + s).trim();
      }
    }

    if (current.length >= 80) chunks.push(current);
  }

  const unique = [...new Set(chunks)];
  const examples = [];

  for (const chunk of unique.slice(0, limit)) {
    examples.push({
      frage: `Was steht im Wikipedia-Artikel „${title}“ über ${title}?`,
      antwort: chunk
    });
  }

  return examples;
}

app.post("/api/convert", async (req, res) => {
  const { urls, maxPerArticle = 20 } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: "Bitte mindestens einen Wikipedia-Link senden."
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
      error: "Beispiele pro Artikel müssen zwischen 1 und 100 liegen."
    });
  }

  const data = [];
  const articles = [];

  for (const input of urls) {
    try {
      const requestedTitle = parseWikipediaUrl(input);
      const article = await getArticle(requestedTitle);
      const examples = makeExamples(article.title, article.text, limit);

      data.push(...examples);
      articles.push({
        title: article.title,
        count: examples.length
      });
    } catch (error) {
      articles.push({
        title: String(input).slice(0, 150),
        count: 0,
        error: error.message
      });
    }
  }

  if (data.length === 0) {
    return res.status(422).json({
      error: "Keine geeigneten Absätze gefunden.",
      articles
    });
  }

  res.json({ data, articles });
});

app.get("/api/status", (req, res) => {
  res.json({ status: "online", service: "Wikipedia-to-JSON" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
