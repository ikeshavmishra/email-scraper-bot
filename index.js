const express = require("express");
const cors = require("cors");
const EmailScraper = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// timing middleware
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

function validateScrapeRequest(req, res, next) {
  const body = req.body || {};
  const { url, maxPages, concurrency, fast, maxEmails } = body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      success: false,
      error: "Missing 'url' (string) in request body.",
    });
  }

  if (maxPages !== undefined && isNaN(Number(maxPages))) {
    return res.status(400).json({ success: false, error: "'maxPages' must be a number." });
  }
  if (concurrency !== undefined && isNaN(Number(concurrency))) {
    return res.status(400).json({ success: false, error: "'concurrency' must be a number." });
  }
  if (maxEmails !== undefined && isNaN(Number(maxEmails))) {
    return res.status(400).json({ success: false, error: "'maxEmails' must be a number." });
  }
  if (fast !== undefined && typeof fast !== "boolean") {
    return res.status(400).json({ success: false, error: "'fast' must be a boolean." });
  }

  next();
}

app.post("/api/scrape", validateScrapeRequest, async (req, res) => {
  try {
    let {
      url,
      maxPages = 30,       // faster default for free servers
      concurrency = 4,     // sweet spot for Render free
      fast = true,         // fast mode ON by default
      maxEmails = 2        // stop early after N emails
    } = req.body;

    // safety bounds
    maxPages = Math.max(1, Math.min(Number(maxPages) || 30, 500));
    concurrency = Math.max(1, Math.min(Number(concurrency) || 4, 20));
    maxEmails = Math.max(1, Math.min(Number(maxEmails) || 2, 50));

    const scraper = new EmailScraper(url, {
      maxPages,
      concurrency,
      fast,
      maxEmails,
    });

    const emails = await scraper.scrapeWebsite();

    res.json({
      success: true,
      // base URL after filtering long links
      url: scraper.baseUrl,
      inputUrl: url,
      maxPages,
      concurrency,
      fast,
      maxEmails,
      pagesScanned: scraper.visitedUrls.size,
      emailsFound: emails.length,
      emails,
      processingTime: `${((Date.now() - req.startTime) / 1000).toFixed(2)}s`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});