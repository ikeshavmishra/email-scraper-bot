const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const http = require("http");
const https = require("https");

/**
 * Convert any long URL to the base site URL:
 * - accept "mysite.com/page?x=1" => "https://mysite.com/"
 * - keep protocol, origin only
 */
function toBaseUrl(input) {
  if (!input || typeof input !== "string") return null;
  let raw = input.trim();

  // if user didn't include protocol
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

/**
 * Normalize URL for dedupe:
 * - resolve relative URLs
 * - remove hash
 * - lowercase hostname
 * - remove default port
 * - remove trailing slash (except root)
 */
function normalizeUrl(url, baseForRelative) {
  try {
    const u = baseForRelative ? new URL(url, baseForRelative) : new URL(url);

    u.hash = "";
    u.hostname = u.hostname.toLowerCase();

    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = "";
    }

    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return null;
  }
}

/**
 * TLD validation (domain extension):
 * - only letters
 * - length 2..24 (covers almost all real TLDs; avoids garbage)
 */
function isValidTld(tld) {
  if (!tld) return false;
  const x = tld.toLowerCase();
  return /^[a-z]{2,24}$/.test(x);
}

/**
 *
 * only strip label if it appears immediately before local-part with no whitespace.
 */
function stripEmailLabelGlue(rawCandidate) {
  const s = rawCandidate.trim();
  const at = s.indexOf("@");
  if (at <= 0) return s;

  const left = s.slice(0, at);
  const right = s.slice(at + 1);

  const lowerLeft = left.toLowerCase();

  const idxEmail = lowerLeft.lastIndexOf("email");
  const idxEMail = lowerLeft.lastIndexOf("e-mail");
  const idx = Math.max(idxEmail, idxEMail);

  if (idx === -1) return s;

  const labelLen = idxEMail === idx ? "e-mail".length : "email".length;
  let cutPos = idx + labelLen;

  // remove separators immediately after label
  while (cutPos < left.length && /[:\-_]/.test(left[cutPos])) {
    cutPos++;
  }

  const newLeft = left.slice(cutPos);
  if (!newLeft) return s;

  return `${newLeft}@${right}`;
}

/**
 * Extract text nodes separately so avoid creating
 */
function getAllTextNodes($) {
  const parts = [];
  $("body")
    .find("*")
    .contents()
    .each((_, node) => {
      if (node.type === "text") {
        const t = String(node.data || "")
          .replace(/\u00A0/g, " ")
          .trim();
        if (t) parts.push(t);
      }
    });

  // fallback if empty
  if (parts.length === 0) {
    const t = ($("body").text() || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
    if (t) parts.push(t);
  }

  return parts;
}

class EmailScraper {
  constructor(inputUrl, options = {}) {
    // feature: filter long URL -> base url
    const baseUrl = toBaseUrl(inputUrl);
    if (!baseUrl) throw new Error("Invalid URL. Please provide a valid http/https URL.");

    this.baseUrl = baseUrl;
    this.baseDomain = new URL(this.baseUrl).hostname;

    // options
    this.maxPages = Math.max(1, Math.min(Number(options.maxPages || 30), 500));
    this.concurrency = Math.max(1, Math.min(Number(options.concurrency || 4), 20));
    this.fast = options.fast !== undefined ? !!options.fast : true;

    // stop early after N emails
    this.maxEmails = Math.max(1, Math.min(Number(options.maxEmails || 2), 50));

    // queue (no shift)
    this.queue = [];
    this.qIndex = 0;

    this.visitedUrls = new Set();
    this.enqueuedUrls = new Set();

    this.emails = new Set();

    // keep-alive improves speed for multiple pages
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: this.concurrency });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: this.concurrency });

    this.client = axios.create({
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "EmailScraperBot/1.0",
        "Accept": "text/html,application/xhtml+xml",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    // seed queue (FAST mode: high-signal pages first)
    this.seedQueue();
  }

  /**
   * Boundary-aware email regex:
   * - reduces matches inside larger strings
   * Note: uses lookbehind/lookahead (modern Node OK).
   */
  emailRegex = /(?<![A-Z0-9._%+-])([A-Z0-9._%+-]{1,64})@([A-Z0-9.-]+\.[A-Z]{2,24})(?![A-Z0-9._%+-])/gi;

  seedQueue() {
    const base = this.baseUrl;

    // Always include homepage
    this.enqueue(base);

    if (!this.fast) return;

    // Try contact-like pages first (big speed boost)
    const likelyPages = [
      "contact",
      "contact-us",
      "about",
      "about-us",
      "support",
      "help",
      "privacy",
      "terms",
      "impressum",
    ];

    for (const p of likelyPages) {
      this.enqueue(new URL(p, base).toString());
    }
  }

  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  isSameDomain(url) {
    try {
      return new URL(url).hostname === this.baseDomain;
    } catch {
      return false;
    }
  }

  enqueue(link) {
    const norm = normalizeUrl(link, this.baseUrl);
    if (!norm) return;
    if (!this.isSameDomain(norm)) return;
    if (this.visitedUrls.has(norm)) return;
    if (this.enqueuedUrls.has(norm)) return;

    this.enqueuedUrls.add(norm);
    this.queue.push(norm);
  }

  getNextUrl() {
    while (this.qIndex < this.queue.length) {
      const url = this.queue[this.qIndex++];
      if (!url) continue;
      if (this.visitedUrls.has(url)) continue;
      return url;
    }
    return null;
  }

  /**
   * Strong cleaning + domain extension check
   */
  cleanEmail(candidate) {
    if (!candidate || typeof candidate !== "string") return null;

    let email = candidate.trim();

    // remove wrapping punctuation
    email = email.replace(/^[<("'\[\{]+/, "").replace(/[>)"'\]\}.,;:!]+$/, "");

    // fix "E-Mailbusiness@domain.com"
    email = stripEmailLabelGlue(email);

    // reject whitespace
    if (/\s/.test(email)) return null;

    // validate full email
    const m = email.match(/^([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]{1,253})$/);
    if (!m) return null;

    // const local = m[1];
    // const domain = m[2];

    let local = m[1];
    const domain = m[2];

    // FIX 1: strip URL-encoded whitespace prefix like "%20info@email.com"
    if (/^%(?:20|09|0a|0d)+/i.test(local)) {
    local = local.replace(/^%(?:20|09|0a|0d)+/i, "");
   }

    // FIX 2: strip percent-prefix glue like "20%info@email.com"
    if (/^\d{1,3}%[A-Za-z]/.test(local)) {
    local = local.replace(/^\d{1,3}%+/, "");
    }

    // after stripping, local must still be valid
    if (!local) return null;
    if (!/^[A-Za-z0-9._%+-]{1,64}$/.test(local)) return null;

    // must contain dot
    const lastDot = domain.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === domain.length - 1) return null;

    const tld = domain.slice(lastDot + 1);

    // domain extension check
    if (!isValidTld(tld)) return null;

    // reject suspicious domain patterns
    if (domain.includes("..")) return null;
    if (/[-.]$/.test(domain) || /^[-.]/.test(domain)) return null;

    return `${local}@${domain}`;
  }

  storeEmail(candidate) {
    const cleaned = this.cleanEmail(candidate);
    if (!cleaned) return;

    this.emails.add(cleaned);
  }

  shouldStop() {
    return this.emails.size >= this.maxEmails || this.visitedUrls.size >= this.maxPages;
  }

  async fetchPage(url) {
    try {
      const { data, headers } = await this.client.get(url, {
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
      });

      const ct = String(headers?.["content-type"] || "").toLowerCase();
      if (ct && !ct.includes("text/html") && !ct.includes("application/xhtml")) return null;

      // skip huge pages (helps free tier)
      const len = Number(headers?.["content-length"] || 0);
      if (len && len > 2_500_000) return null; // 2.5MB

      if (typeof data !== "string") return null;
      return data;
    } catch {
      return null;
    }
  }

  parsePage(html) {
    const $ = cheerio.load(html);

    // 1) mailto links (best)
    $("a[href^='mailto:']").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      const mail = href.replace(/^mailto:/i, "").split("?")[0].trim();
      if (mail) this.storeEmail(mail);
    });

    if (this.shouldStop()) return;

    // 2) meta content
    $("meta[content]").each((_, el) => {
      const content = ($(el).attr("content") || "").trim();
      if (!content) return;

      const matches = content.match(this.emailRegex);
      if (matches) matches.forEach((e) => this.storeEmail(e));
    });

    if (this.shouldStop()) return;

    // 3) body text nodes (separate tokens to reduce glue)
    const textParts = getAllTextNodes($);

    for (const part of textParts) {
      const matches = part.match(this.emailRegex);
      if (matches) matches.forEach((e) => this.storeEmail(e));
      if (this.shouldStop()) break;
    }

    if (this.shouldStop()) return;

    // 4) enqueue links
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (/^(javascript:|tel:|mailto:)/i.test(href)) return;
      this.enqueue(href);
    });
  }

  async worker() {
    while (!this.shouldStop()) {
      const url = this.getNextUrl();
      if (!url) return;

      this.visitedUrls.add(url);

      const html = await this.fetchPage(url);
      if (html) this.parsePage(html);

      // small delay + jitter (less blocking, less CPU spikes)
      await this.delay(120 + Math.floor(Math.random() * 120));
    }
  }

  async scrapeWebsite() {
    const workers = Array.from({ length: this.concurrency }, () => this.worker());
    await Promise.all(workers);
    return [...this.emails];
  }
}

module.exports = EmailScraper;
