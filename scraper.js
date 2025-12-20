const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

class EmailScraper {
    constructor(baseUrl, options = {}) {
        this.baseUrl = baseUrl;
        this.baseDomain = new URL(baseUrl).hostname;

        this.maxPages = options.maxPages || 50;
        this.concurrency = options.concurrency || 5;

        this.visitedUrls = new Set();
        this.queue = [baseUrl];

        // Email storage
        this.emails = new Set();            // full emails
        this.emailDomains = new Set();      // dedup by domain
    }

    emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isSameDomain(url) {
        try {
            return new URL(url).hostname === this.baseDomain;
        } catch {
            return false;
        }
    }

    normalizeUrl(url) {
        try {
            return new URL(url, this.baseUrl).href.split('#')[0];
        } catch {
            return null;
        }
    }

    extractEmails(text) {
        return text.match(this.emailRegex) || [];
    }

    async fetchPage(url) {
        try {
            const { data } = await axios.get(url, {
                timeout: 10000,
                headers: { 'User-Agent': 'EmailScraperBot/1.0' }
            });
            return data;
        } catch {
            return null;
        }
    }

    parsePage(html) {
        const $ = cheerio.load(html);
        const text = $('body').text();

        // EMAIL EXTRACTION (DEDUP BY DOMAIN)
        this.extractEmails(text).forEach(email => {
            const domain = email.split('@')[1].toLowerCase();
            if (!this.emailDomains.has(domain)) {
                this.emailDomains.add(domain);
                this.emails.add(email);
            }
        });

        // LINK EXTRACTION
        $('a[href]').each((_, el) => {
            const link = this.normalizeUrl($(el).attr('href'));
            if (
                link &&
                this.isSameDomain(link) &&
                !this.visitedUrls.has(link)
            ) {
                this.queue.push(link);
            }
        });
    }

    // 🚀 CONCURRENT WORKER
    async worker() {
        while (
            this.queue.length > 0 &&
            this.visitedUrls.size < this.maxPages
        ) {
            const url = this.queue.shift();
            if (!url || this.visitedUrls.has(url)) continue;

            this.visitedUrls.add(url);

            const html = await this.fetchPage(url);
            if (html) this.parsePage(html);

            await this.delay(300); // polite crawling
        }
    }

    async scrapeWebsite() {
        const workers = [];

        for (let i = 0; i < this.concurrency; i++) {
            workers.push(this.worker());
        }

        await Promise.all(workers);
        return [...this.emails];
    }
}

module.exports = EmailScraper;
