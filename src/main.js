import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

/**
 * FlexJobs scraper using HTTP + Cheerio (no headless browser).
 * Keeps the original stacks (Apify + Crawlee + Cheerio) and adds:
 * - Proxy support & session rotation
 * - Anti-blocking with realistic headers (handled by got-scraping internally)
 * - Robust selectors for FlexJobs list and detail pages
 * - Conservative pagination discovery
 * - Result cap via `results_wanted`
 *
 * Input (kept for backward compatibility, though FlexJobs does not expose open search params):
 * {
 *   "results_wanted": 100,
 *   "maxPagesPerList": 25,
 *   "maxConcurrency": 10,
 *   "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
 * }
 */

await Actor.init();

const input = await Actor.getInput() || {};
const {
    // Kept for compatibility; FlexJobs search does not accept these openly for anonymous users
    keyword,
    location,
    posted_date = 'anytime',

    // Actively used:
    results_wanted = 100,
    maxPagesPerList = 25,
    maxConcurrency = 10,
    proxyConfiguration,
} = input;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

let jobCount = 0;

// Deduplicate by job URL
const seen = new Set();

// A couple of public "seed" pages to crawl and discover jobs/category pages.
// We intentionally do NOT construct a search URL from input fields because FlexJobs gates most query functionality.
const seeds = [
    'https://www.flexjobs.com/remote-jobs', // categories hub
    'https://www.flexjobs.com/remote-jobs/legitimate-work-from-home-jobs-hiring-now', // "New Jobs"
];

// Utility: normalize to absolute URL
const abs = (href) => {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.flexjobs.com${href}`;
    return `https://www.flexjobs.com/${href.replace(/^\/+/, '')}`;
};

// Extract label/value pairs on the job detail page where data is presented as:
// <h1>Title</h1>
// <h5>Remote Level:</h5><div>...</div>
// <h5>Location:</h5><div>...</div>
// (...)
// Structure may differ for some ads, so we try multiple patterns.
const readLabeledValue = ($, label) => {
    // Try by header tag
    let el = $(`h5:contains("${label}")`).first();
    if (el.length) {
        // Prefer next sibling's text (common on FlexJobs)
        const nextText = el.next().text().trim();
        if (nextText) return nextText;
        // Or text within the same parent after label
        const parent = el.parent();
        if (parent.length) {
            const text = parent.text().replace(new RegExp(`${label}\\s*:?\\s*`, 'i'), '').trim();
            if (text) return text;
        }
    }

    // Try definition list dt/dd
    el = $(`dt:contains("${label}")`).first();
    if (el.length) {
        const dd = el.next('dd').text().trim();
        if (dd) return dd;
    }

    // Try bold label + following text
    el = $(`strong:contains("${label}")`).first();
    if (el.length) {
        const tail = el.parent().text().replace(new RegExp(`${label}\\s*:?\\s*`, 'i'), '').trim();
        if (tail) return tail;
    }

    return null;
};

// Crawler
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    useSessionPool: true,
    persistCookiesPerSession: false,
    maxRequestRetries: 3,
    maxConcurrency,
    // Avoid overwhelming the site
    maxRequestsPerMinute: 120,
    // Moderate timeout for cheap pages
    requestHandlerTimeoutSecs: 60,
    // CheerioCrawler uses got-scraping under the hood with HeaderGenerator, which rotates realistic headers.
    requestHandler: async (ctx) => {
        const { request, $, enqueueLinks, log } = ctx;
        const { userData } = request;
        const label = userData.label || 'ROOT';

        if (label === 'ROOT') {
            // From hub pages, collect category/listing pages and direct public job detail links.
            // Category/list page URLs look like /remote-jobs/<slug> or deeper like /remote-jobs/<category>/<sub>
            const listLinks = new Set();

            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;

                // Collect public job detail pages
                if (/^\/publicjobs\//.test(href) || /https?:\/\/www\.flexjobs\.com\/publicjobs\//.test(href)) {
                    listLinks.add(abs(href));
                    return;
                }

                // Collect category/list pages
                if (/^\/remote-jobs(\/|$)/.test(href) || /https?:\/\/www\.flexjobs\.com\/remote-jobs/.test(href)) {
                    // Avoid login/signup links, and over-broad hubs we already have
                    const url = abs(href);
                    if (!/\/(how|works|blog|articles|events|webinars|career|advice|press|app|research)/i.test(url)) {
                        listLinks.add(url);
                    }
                }
            });

            const toAdd = [];
            for (const url of listLinks) {
                // Push category/list as LIST; publicjobs as DETAIL
                if (/\/publicjobs\//i.test(url)) {
                    toAdd.push({ url, userData: { label: 'DETAIL' } });
                } else {
                    toAdd.push({ url, userData: { label: 'LIST', page: 1 } });
                }
            }

            if (toAdd.length) await ctx.addRequests(toAdd);
            return;
        }

        if (label === 'LIST') {
            // Extract public job links from any listing-like page.
            const jobLinks = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                if (/^\/publicjobs\//.test(href) || /https?:\/\/www\.flexjobs\.com\/publicjobs\//.test(href)) {
                    jobLinks.add(abs(href));
                }
            });

            const detailRequests = [];
            for (const url of jobLinks) {
                if (jobCount >= results_wanted) break;
                if (seen.has(url)) continue;
                seen.add(url);
                detailRequests.push({ url, userData: { label: 'DETAIL' } });
            }

            if (detailRequests.length) await ctx.addRequests(detailRequests);

            // Respect results cap early
            if (jobCount >= results_wanted) return;

            // Discover "Next" pages (if present).
            // We try common patterns first.
            let nextHref = $('a[rel="next"]').attr('href') ||
                           $('a:contains("Next")').attr('href') ||
                           $('a:contains("Older")').attr('href') ||
                           $('a:contains("More")').attr('href') ||
                           $('a[href*="page="]').attr('href');

            // Fallback: synthetically construct ?page=N if we can
            let currentUrl = request.url;
            const currentPage = Number(userData.page || 1);

            if (!nextHref && currentPage < maxPagesPerList) {
                const urlObj = new URL(currentUrl);
                const nextPageNum = currentPage + 1;

                if (!urlObj.searchParams.has('page')) {
                    urlObj.searchParams.set('page', String(nextPageNum));
                } else {
                    urlObj.searchParams.set('page', String(nextPageNum));
                }

                nextHref = urlObj.toString();
            }

            if (nextHref && currentPage < maxPagesPerList) {
                await ctx.addRequests([{
                    url: abs(nextHref),
                    userData: { label: 'LIST', page: currentPage + 1 },
                }]);
            }

            return;
        }

        if (label === 'DETAIL') {
            if (jobCount >= results_wanted) return;

            const url = request.url;
            const title = ($('h1').first().text() || '').trim();

            const record = {
                source: 'flexjobs',
                url,
                title,
                remote_level: readLabeledValue($, 'Remote Level'),
                location: readLabeledValue($, 'Location'),
                salary: readLabeledValue($, 'Salary'),
                benefits: readLabeledValue($, 'Benefits'),
                job_type: readLabeledValue($, 'Job Type'),
                schedule: readLabeledValue($, 'Job Schedule'),
                career_level: readLabeledValue($, 'Career Level'),
                company: readLabeledValue($, 'Company'),
                // Description content on public pages is limited; capture visible text blocks as fallback
                // and keep raw HTML for consumers that want to parse further.
                description_html: (() => {
                    // Try to find a primary content container near the title
                    const main = $('main, article, #content, .content').first();
                    if (main.length) return main.html();
                    // Fallback to body
                    return $('body').html();
                })(),
                description_text: (() => {
                    const main = $('main, article, #content, .content').first();
                    const text = (main.length ? main.text() : $('body').text()) || '';
                    return text.replace(/\s+/g, ' ').trim();
                })(),
                scraped_at: new Date().toISOString(),
            };

            await Dataset.pushData(record);
            jobCount += 1;

            // Respect results cap
            if (jobCount >= results_wanted) {
                log.info(`Reached results_wanted=${results_wanted}, stopping soon.`);
            }

            return;
        }
    },
});

// Seed the crawl
const startRequests = seeds.map((url) => ({ url, userData: { label: 'ROOT' } }));

log.info('Starting FlexJobs scrape with CheerioCrawler...');
log.info(`Seeds: ${seeds.join(', ')}`);
log.info(`Results wanted: ${results_wanted}`);

await crawler.run(startRequests);

log.info(`Scraping finished. Scraped ${jobCount} jobs.`);

await Actor.exit();
