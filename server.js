const WIKI_PAUSE_MS = 7000;

// Alle Wikipedia-Anfragen werden nacheinander ausgeführt.
let wikiRequestQueue = Promise.resolve();

function wikipediaRequest(url) {
  const task = wikiRequestQueue.then(async () => {
    let response;

    try {
      response = await fetch(url, {
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
      console.log("Wikipedia-Anfrage beendet. Pause: 7 Sekunden.");
      await sleep(WIKI_PAUSE_MS);
    }
  });

  // Die Warteschlange bleibt auch nach Fehlern funktionsfähig.
  wikiRequestQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

async function fetchJson(url, attempts = 4) {
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
        `Netzwerkfehler. Neuer Versuch in ${wait / 1000} Sekunden.`
      );

      await sleep(wait);
      continue;
    }

    const retryAfter = retryAfterMilliseconds(result.retryAfter);

    if (result.status === 429 || result.status === 503) {
      lastError = new Error(`HTTP ${result.status}`);

      if (attempt >= attempts) break;

      const wait = retryAfter !== null
        ? retryAfter
        : 5000 * (2 ** (attempt - 1));

      console.warn(
        `Wikipedia drosselt Anfragen. Zusätzliche Wartezeit: ` +
        `${Math.ceil(wait / 1000)} Sekunden.`
      );

      await sleep(wait);
      continue;
    }

    if (result.status < 200 || result.status >= 300) {
      throw makeError(
        `Wikipedia antwortet mit HTTP ${result.status}: ` +
        result.body.slice(0, 150),
        result.status
      );
    }

    let json;

    try {
      json = JSON.parse(result.body);
    } catch {
      throw new Error("Wikipedia hat ungültiges JSON geliefert.");
    }

    if (json.error) {
      const code = json.error.code || "";
      const message = json.error.info || "Unbekannter API-Fehler";

      if (code === "ratelimited" || code === "maxlag") {
        lastError = new Error(`${code}: ${message}`);

        if (attempt >= attempts) break;

        const wait = retryAfter !== null
          ? retryAfter
          : 5000 * (2 ** (attempt - 1));

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
