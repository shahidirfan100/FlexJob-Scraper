/**
 * src/main.js
 * CheerioCrawler-based FlexJobs scraper with advanced anti-bot headers + randomized delays.
 *
 * - Keeps CheerioCrawler (no Playwright)
 * - Rotates User-Agent, Accept-Language, sec-ch-ua headers per request
 * - Adds randomized delays (jitter) between requests
 * - Injects cookies from input (array of {name, value})
 * - Robust metadata extraction from the job's metadata UL (avoids "Similar Jobs" contamination)
 * - Cleans description HTML and re-parses to avoid trailing broken closing tags
 * - Marks sessions bad on 403/429 to trigger rotation
 */

import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

// ---------- Configurable pools ----------
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const SEC_CH_UA_POOL = [
    '"Chromium";v="123", "Google Chrome";v="123", "Not;A=Brand";v="99"',
    '"Not.A/Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"',
    '"Google Chrome";v="123", "Chromium";v="123", "Not;A=Brand";v="99"',
];

const ACCEPT_LANG_POOL = [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'en;q=0.8',
];

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs + 1)); }

// ---------- Inputs ----------
const {
    results_wanted = 100,
    maxPagesPerList = 20,
    maxConcurrency = 6,
    proxyConfiguration,
    startUrls = [
        'https://www.flexjobs.com/remote-jobs',
        'https://www.flexjobs.com/remote-jobs/legitimate-work-from-home-jobs-hiring-now',
    ],
    cookies = [], // optional [{name, value}, ...]
} = await Actor.getInput() || {};

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// ---------- Utility functions ----------

/**
 * Find the UL that contains the job metadata (Remote Level, Location, Company, etc)
 * We scope by the <h1> (job title) and look for UL with H5 labels inside.
 */
function findMetaList($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main') : $('main').first();

    let $meta = $main.find('ul').filter((_, ul) => {
        const $ul = $(ul);
        return $ul.find('h5').filter((__, h5) => {
            const t = $(h5).text().trim().toLowerCase();
            return /remote level|location|salary|benefits|job type|job schedule|career level|company/.test(t);
        }).length > 0;
    }).first();

    if (!$meta.length) {
        $meta = $('ul').filter((_, ul) => {
            const $ul = $(ul);
            return $ul.find('h5').filter((__, h5) => {
                const t = $(h5).text().trim().toLowerCase();
                return /remote level|location|salary|benefits|job type|job schedule|career level|company/.test(t);
            }).length > 0;
        }).first();
    }

    return $meta.length ? $meta : null;
}

/**
 * Extract a strict map of metadata by reading only the metadata UL's LI children.
 * This avoids picking up values from "Similar Jobs".
 */
function extractMetaMap($) {
    const $meta = findMetaList($);
    const map = {};
    if (!$meta) return map;

    $meta.children('li').each((_, li) => {
        const $li = $(li);
        const rawLabel = $li.find('h5').first().text().replace(':', '').trim();
        const value = $li.find('p').first().text().trim().replace(/\s+/g, ' ');
        if (!rawLabel) return;
        const label = rawLabel.toLowerCase();
        if (label.includes('remote level')) map.remote_level = value || null;
        else if (label === 'location') map.location = value || null;
        else if (label === 'salary') map.salary = value || null;
        else if (label === 'benefits') map.benefits = value || null;
        else if (label === 'job type') map.job_type = value || null;
        else if (label === 'job schedule') map.schedule = value || null;
        else if (label === 'career level') map.career_level = value || null;
        else if (label === 'company') map.company = value || null;
    });

    return map;
}

/**
 * Clean description HTML and text:
 * - Scope to the main that contains H1
 * - Remove UI / promos / breadcrumbs / similar jobs etc
 * - Remove <a> anchors entirely
 * - Keep only allowed tags and unwrap others
 * - Remove empty nodes
 * - Run a small regex cleanup
 * - Reparse with cheerio to balance tags
 */
function cleanDescription($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main').clone() : $('main').first().clone();
    if (!$main.length) return { html: null, text: null };

    // Remove obvious UI & promo elements
    $main.find('ul.page-breadcrumb, .unlock-lock, .sc-1qzt8fr-0, .similar-jobs, script, style, nav, header, footer, aside').remove();

    // Find description scope: content after meta UL
    const $meta = findMetaList($);
    let $descScope;
    if ($meta && $meta.length) {
        const $parent = $meta.parent();
        $descScope = $parent.nextAll().clone();
    }
    if (!$descScope || !$descScope.length) $descScope = $main.clone();

    // Remove anchors and their anchor-text
    $descScope.find('a').remove();

    // Remove buttons, svgs, imgs, forms (UI)
    $descScope.find('button, svg, img, form, input, .slick-track, .slick-list, .slick-slider').remove();

    // Remove headings that are promos
    $descScope.find('h2,h3,h4').filter((_, el) => /similar jobs|unlock|find your next/i.test($(el).text())).remove();

    // Strip attributes to reduce noise
    $descScope.find('*').each((_, el) => { el.attribs = {}; });

    // Whitelist tags, unwrap others
    $descScope.find('*').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        if (!['p','ul','li','br','strong','em','h2','h3','h4'].includes(tag)) {
            $(el).replaceWith($(el).html() || '');
        }
    });

    // Remove empty elements
    $descScope.find('*').each((_, el) => {
        const $el = $(el);
        if (!$el.text().trim() && !$el.find('br').length) $el.remove();
    });

    let html = $descScope.html() ? $descScope.html().trim() : null;

    const cleanupRegex = /(Unlock this job[\s\S]*?jobs|Find Your Next Remote Job!?|Only hand-screened, legit jobs|No ads, scams, or junk|Expert resources, webinars & events)/gi;
    if (html) {
        html = html.replace(cleanupRegex, '').replace(/&nbsp;/gi, ' ').replace(/<\/?(div|button|i|svg|span)[^>]*>/gi, '').trim();
    }

    // Re-parse to ensure balanced HTML
    if (html) {
        const cheerio = require('cheerio'); // runtime require
        const $$ = cheerio.load(html);
        html = $$.root().html()?.trim() || null;
    }

    const text = html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html, text };
}

/**
 * Detect blocking by status codes; mark session bad and throw to be retried/rotated.
 */
function detectBlocking(response, session, url) {
    const status = response?.statusCode;
    if (status === 403 || status === 429) {
        log.warning(`Blocked with status ${status} on ${url} — marking session bad.`);
        if (session) session.markBad();
        const err = new Error(`Request blocked - received ${status} status code.`);
        // attach statusCode so crawlee treats as blocked
        err.statusCode = status;
        throw err;
    }
}

// ---------- Crawler ----------

let pushedCount = 0;

const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    useSessionPool: true,
    maxRequestRetries: 6,
    maxConcurrency,
    minConcurrency: 1,
    requestHandlerTimeoutSecs: 90,
    // prepareRequestFunction runs before each HTTP request (CheerioCrawler)
    prepareRequestFunction: async ({ request, session, proxyInfo }) => {
        // Random headers for anti-bot
        const ua = randFrom(USER_AGENTS);
        const secChUa = randFrom(SEC_CH_UA_POOL);
        const acceptLang = randFrom(ACCEPT_LANG_POOL);

        // Build header set
        const headers = {
            'User-Agent': ua,
            'Accept-Language': acceptLang,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Upgrade-Insecure-Requests': '1',
            'Sec-CH-UA': secChUa,
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document',
            // A realistic referer pointing to listing page
            'Referer': 'https://www.flexjobs.com/remote-jobs',
            'Connection': 'keep-alive',
        };

        // Inject cookies if provided
        if (cookies && cookies.length) {
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            headers.Cookie = cookieHeader;
        }

        // Attach to request
        request.headers = {
            ...(request.headers || {}),
            ...headers,
        };

        // No explicit return required for CheerioCrawler's prepareRequestFunction
    },

    // request handler
    async requestHandler({ request, $, response, session, enqueueLinks }) {
        // Random small delay to look human
        await Actor.sleep(jitter(400, 1800));

        // Block detection
        detectBlocking(response, session, request.loadedUrl);

        if (request.userData.label === 'LIST') {
            // Enqueue public job links
            await enqueueLinks({
                selector: 'a[href*="/publicjobs/"]',
                label: 'DETAIL',
                transformRequestFunction: req => {
                    req.userData.label = 'DETAIL';
                    return req;
                },
            });

            // Pagination detection
            let nextHref = $('a[rel="next"]').attr('href') || $('a:contains("Next")').attr('href') || $('a:contains("Older")').attr('href');
            if (nextHref) {
                const abs = new URL(nextHref, request.loadedUrl).href;
                await enqueueLinks({ urls: [abs], label: 'LIST' });
            } else {
                // synthetic page fallback
                const m = request.loadedUrl.match(/[?&]page=(\d+)/);
                let page = m ? parseInt(m[1], 10) : 1;
                if (page < maxPagesPerList) {
                    const hasQuery = request.loadedUrl.includes('?');
                    const sep = hasQuery ? '&' : '?';
                    const replaced = request.loadedUrl.replace(/([?&])page=\d+/, `$1page=${page + 1}`);
                    const finalUrl = replaced === request.loadedUrl ? `${request.loadedUrl}${sep}page=${page + 1}` : replaced;
                    await enqueueLinks({ urls: [finalUrl], label: 'LIST' });
                }
            }
            return;
        }

        if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) return;

            const title = $('h1').first().text().trim() || null;

            const meta = extractMetaMap($);

            let company = meta.company || null;
            if (company && /details here/i.test(company)) {
                log.debug(`Company hidden (mask) at ${request.loadedUrl}. Returning null for company.`);
                company = null;
            }

            // Normalize some common noisy location strings (optional)
            let location = meta.location ?? null;
            if (location) {
                location = location.replace(/\s+/g, ' ').trim();
                // If location is like "US National" or similar, keep as-is (that's FlexJobs semantics)
            }

            // Build job object with correct mapping
            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: meta.remote_level ?? null,
                location: location,
                salary: meta.salary ?? null,
                benefits: meta.benefits ?? null,
                job_type: meta.job_type ?? null,    // Employee / Freelance / Contract etc.
                schedule: meta.schedule ?? null,    // Full-Time / Part-Time
                career_level: meta.career_level ?? null,
                company,
                scraped_at: new Date().toISOString(),
            };

            // Clean description
            const desc = cleanDescription($);
            job.description_html = desc.html;
            job.description_text = desc.text;

            await Actor.pushData(job);
            pushedCount++;
            return;
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request ${request.url} failed too many times. Last error: ${error?.message}`);
    },
});

// Run
await crawler.run(startUrls.map(url => ({ url, userData: { label: 'LIST' } })));

await Actor.exit();
