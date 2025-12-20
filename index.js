const express = require('express');
const cors = require('cors');
const EmailScraper = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ⏱️ START TIMER (FIXED POSITION)
app.use((req, res, next) => {
    req.startTime = Date.now();
    next();
});

// Request validation
const validateScrapeRequest = (req, res, next) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'URL is required',
            example: { url: 'https://example.com' }
        });
    }

    try {
        new URL(url);
        next();
    } catch {
        return res.status(400).json({
            error: 'Invalid URL format'
        });
    }
};

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        service: 'Email Scraper Bot',
        timestamp: new Date().toISOString()
    });
});

// Scrape endpoint
app.post('/api/scrape', validateScrapeRequest, async (req, res) => {
    try {
        const { url, maxPages = 50, concurrency = 5 } = req.body;

        const scraper = new EmailScraper(url, {
            maxPages,
            concurrency
        });

        const emails = await scraper.scrapeWebsite();

        res.json({
            success: true,
            url,
            pagesScanned: scraper.visitedUrls.size,
            emailsFound: emails.length,
            emails,
            processingTime: `${((Date.now() - req.startTime) / 1000).toFixed(2)}s`
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 404
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found'
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
