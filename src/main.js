import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// ===== Anti-bot header pool =====
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs + 1)); }

await Actor.init();

const {
    results_wanted = 100,
    maxPagesPerList = 20,
    maxConcurrency = 8,
    proxyConfiguration,
    startUrls = [
        'https://www.flexjobs.com/remote-jobs',
        'https://www.flexjobs.com/remote-jobs/legitimate-work-from-home-jobs-hiring-now',
    ],
    cookies = [],
} = await Actor.getInput() || {};

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

let pushedCount = 0;

// ================= Helpers =================

// Find the specific UL near the main H1 that holds meta rows (Remote Level, Location, etc)
function findMetaList($) {
    // Scope to the <main> that contains the first H1 (job title)
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main') : $('main').first();

    // Find the first UL under that main that contains any H5 label like "Remote Level:" etc.
    let $meta = $main.find('ul').filter((_, ul) => {
        const $ul = $(ul);
        return $ul.find('h5').filter((__, h5) => {
            const t = $(h5).text().trim().toLowerCase();
            return /remote level|location|salary|benefits|job type|job schedule|career level|company/.test(t);
        }).length > 0;
    }).first();

    // If not found under that main, fallback to any UL in document matching labels
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

// Build a label -> value map strictly from the meta UL (avoids “Similar jobs” contamination)
function extractMetaMap($) {
    const $meta = findMetaList($);
    const map = {};
    if (!$meta) return map;

    $meta.children('li').each((_, li) => {
        const $li = $(li);
        const label = $li.find('h5').first().text().replace(':', '').trim();
        const value = $li.find('p').first().text().trim().replace(/\s+/g, ' ');
        if (!label) return;

        const norm = label.toLowerCase();
        if (norm.includes('remote level')) map.remote_level = value || null;
        else if (norm === 'location') map.location = value || null;
        else if (norm === 'salary') map.salary = value || null;
        else if (norm === 'benefits') map.benefits = value || null;
        else if (norm === 'job type') map.job_type = value || null;          // e.g., Employee, Freelance, Contract
        else if (norm === 'job schedule') map.schedule = value || null;      // e.g., Full-Time
        else if (norm === 'career level') map.career_level = value || null;
        else if (norm === 'company') map.company = value || null;
    });

    return map;
}

// Clean description HTML while keeping readable structure
function cleanDescription($) {
    // Work inside the main that contains the H1
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main').clone() : $('main').first().clone();

    if (!$main.length) return { html: null, text: null };

    // Remove junk sections before narrowing (breadcrumbs, unlock promos, similar jobs, navs)
    $main.find('ul.page-breadcrumb, .unlock-lock, .sc-1qzt8fr-0, .similar-jobs, script, style, nav').remove();

    // Heuristic: description is the content AFTER the metadata UL and BEFORE any "Similar Jobs" block
    const $meta = findMetaList($);
    let $descScope = $main;
    if ($meta && $meta.length) {
        // Use the parent section around metadata as anchor
        const $parent = $meta.parent();
        // Description likely in siblings following metadata parent
        $descScope = $parent.nextAll().clone();
    }

    // If that fails (empty), fallback to the original main content
    if (!$descScope || !$descScope.length) $descScope = $main;

    // Remove obvious UI elements & all anchors (and their anchor texts)
    $descScope.find('a, button, svg, img, form, header, footer, aside').remove();

    // Remove any headings that are clearly non-description (e.g., Similar Jobs)
    $descScope.find('h2,h3,h4').filter((_, el) => /similar jobs|unlock/i.test($(el).text())).remove();

    // Strip attributes to avoid noisy classnames, inline styles
    $descScope.find('*').each((_, el) => { el.attribs = {}; });

    // Allow only readable tags; unwrap others (keeps inner text)
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

    // Compose cleaned HTML
    let html = $descScope.html() ? $descScope.html().trim() : null;

    // Regex cleanup: FlexJobs promos & stray tags that sometimes slip through
    const cleanupRegex = /(Unlock this job[\s\S]*?jobs|Find Your Next Remote Job!?|Only hand-screened, legit jobs|No ads, scams, or junk|Expert resources, webinars & events)/gi;
    if (html) {
        html = html
            .replace(cleanupRegex, '')
            .replace(/<\/?(div|button|i|svg|span)[^>]*>/gi, '')
            .replace(/&nbsp;/gi, ' ')
            .trim();
    }

    // Re-parse to normalize & ensure balanced HTML (prevents trailing </div>…)
    if (html) {
        const $$ = loadHtml(html);
        html = $$.root().html()?.trim() || null;
    }

    const text = html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html, text };
}

// A tiny helper to reparse HTML with cheerio (ensures balanced markup)
function loadHtml(fragment) {
    // Cheerio v1 signatures (no external opts needed)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cheerio = require('cheerio');
    return cheerio.load(fragment);
}

// Mark session bad and throw on 403 to trigger rotation
function handlePotentialBlock({ response, session, requestUrl }) {
    const status = response?.statusCode;
    if (status === 403 || status === 429) {
        log.warning(`Blocked with status ${status} at ${requestUrl}; rotating session.`);
        if (session) session.markBad();
        const err = new Error(`Request blocked - received ${status} status code.`);
        // @ts-ignore annotate to let Crawlee retry
        err.statusCode = status;
        throw err;
    }
}

// ================= Crawler =================

const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    useSessionPool: true,
    maxRequestRetries: 6,
    maxConcurrency,
    minConcurrency: 2,
    requestHandlerTimeoutSecs: 75,
    retryOnBlocked: true,

    // Anti-bot headers + cookies per request
    preNavigationHooks: [
        async ({ session }, gotoOptions) => {
            const ua = randFrom(USER_AGENTS);
            gotoOptions.headers = {
                ...(gotoOptions.headers || {}),
                'User-Agent': ua,
                'Accept-Language': randFrom(['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en;q=0.8']),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
            };
            if (cookies && cookies.length) {
                const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                gotoOptions.headers.Cookie = cookieHeader;
            }
        },
    ],

    async requestHandler(ctx) {
        const { request, $, response, session, enqueueLinks } = ctx;

        // Block detection (403/429)
        handlePotentialBlock({ response, session, requestUrl: request.loadedUrl });

        // Random small delay to stagger pattern
        await Actor.sleep(jitter(300, 1200));

        if (request.userData.label === 'LIST') {
            // Enqueue job detail pages (public jobs)
            await enqueueLinks({
                selector: 'a[href*="/publicjobs/"]',
                label: 'DETAIL',
                transformRequestFunction: (req) => {
                    req.userData.label = 'DETAIL';
                    return req;
                },
            });

            // Native pagination
            let nextHref = $('a[rel="next"]').attr('href')
                || $('a:contains("Next")').attr('href')
                || $('a:contains("Older")').attr('href');

            if (nextHref) {
                const abs = new URL(nextHref, request.loadedUrl).href;
                await enqueueLinks({ urls: [abs], label: 'LIST' });
            } else {
                // Synthetic ?page= fallback with cap
                const m = request.loadedUrl.match(/[?&]page=(\d+)/);
                let page = m ? parseInt(m[1], 10) : 1;
                if (page < maxPagesPerList) {
                    const hasQuery = request.loadedUrl.includes('?');
                    const sep = hasQuery ? '&' : '?';
                    const replaced = request.loadedUrl.replace(/([?&])page=\d+/, `$1page=${page + 1}`);
                    const finalUrl = replaced === request.loadedUrl
                        ? `${request.loadedUrl}${sep}page=${page + 1}`
                        : replaced;
                    await enqueueLinks({ urls: [finalUrl], label: 'LIST' });
                }
            }
            return;
        }

        if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) return;

            // Title
            const title = $('h1').first().text().trim() || null;

            // Extract metadata map strictly from the job meta UL
            const meta = extractMetaMap($);

            // Company visibility handling
            let company = meta.company || null;
            if (company && /details here/i.test(company)) {
                log.debug(`Company hidden on ${request.loadedUrl} (FlexJobs masking). Returning null.`);
                company = null;
            }

            // Build job object with explicit, correct mapping
            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: meta.remote_level ?? null,
                location: meta.location ?? null,   // stays exactly as FlexJobs shows (e.g., "US National" or "Kansas City, MO")
                salary: meta.salary ?? null,
                benefits: meta.benefits ?? null,
                job_type: meta.job_type ?? null,   // "Employee" / "Freelance" / "Contract"
                schedule: meta.schedule ?? null,   // "Full-Time" / "Part-Time" / etc.
                career_level: meta.career_level ?? null,
                company,
                scraped_at: new Date().toISOString(),
            };

            // Description (scoped and sanitized)
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

// Seed
await crawler.run(startUrls.map((url) => ({ url, userData: { label: 'LIST' } })));

// Done
await Actor.exit();
