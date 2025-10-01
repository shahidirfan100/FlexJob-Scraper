import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';

// --- Cookie Helper Functions (from original actor) ---

function normalizeCookieInput(cookiesInput) {
    if (!cookiesInput) return [];
    if (typeof cookiesInput === 'string') {
        return cookiesInput.split(';').map((s) => s.trim()).filter(Boolean);
    }
    if (Array.isArray(cookiesInput)) {
        const out = [];
        for (const c of cookiesInput) {
            if (!c) continue;
            if (typeof c === 'string') out.push(c.trim());
            else if (typeof c === 'object' && c.name && c.value) out.push(`${c.name}=${c.value}`);
        }
        return out;
    }
    if (typeof cookiesInput === 'object') {
        return Object.entries(cookiesInput).map(([k, v]) => `${k}=${v}`);
    }
    return [];
}

function parseCookiesJson(jsonMaybe) {
    if (!jsonMaybe || typeof jsonMaybe !== 'string') return null;
    try { return JSON.parse(jsonMaybe); }
    catch (e) { log.warning('Failed to parse cookiesJson: ' + e.message); return null; }
}

function mergeCookiePairs(pairsA = [], pairsB = []) {
    const map = new Map();
    const push = (pair) => {
        const i = pair.indexOf('=');
        if (i === -1) return;
        map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    };
    pairsA.forEach(push);
    pairsB.forEach(push);
    return Array.from(map, ([k, v]) => `${k}=${v}`);
}

function buildCookieHeaderFromInputs(cookiesRaw, cookiesJsonStr) {
    const jsonParsed = parseCookiesJson(cookiesJsonStr);
    const arrA = normalizeCookieInput(cookiesRaw);
    const arrB = normalizeCookieInput(jsonParsed);
    const merged = mergeCookiePairs(arrA, arrB);
    return merged.length ? merged.join('; ') : null;
}

// --- General Helper Functions ---

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const getAbsoluteUrl = (href) => {
    try {
        if (!href) return null;
        return new URL(href, 'https://www.flexjobs.com').toString();
    } catch {
        return null;
    }
};

// --- Main Actor Logic ---

await Actor.init();

// --- Input Handling ---
const input = await Actor.getInput() || {};
const {
    keyword,
    location,
    posted_date = 'anytime',
    collectDetails = true,
    maxJobs = 50,
    maxPages,
    cookies,
    cookiesJson,
    proxyConfiguration,
} = input;

if (!keyword) {
    throw new Error('Input "keyword" is required.');
}

const cookieHeader = buildCookieHeaderFromInputs(cookies, cookiesJson);
if (cookieHeader) {
    log.info('Using custom cookies.');
}

// --- State Management ---
const state = {
    jobsCount: 0,
    enqueuedCount: 0,
    pagesCount: 0,
};

const getRemainingCapacity = () => maxJobs - (state.jobsCount + state.enqueuedCount);

// --- URL Construction ---
const searchParams = new URLSearchParams();
searchParams.append('search', keyword);
if (location) searchParams.append('location', location);
const dateMap = { '24h': 1, '7d': 7, '30d': 30 };
if (posted_date && dateMap[posted_date]) {
    searchParams.append('posted_date', dateMap[posted_date]);
}
const startUrl = `https://www.flexjobs.com/search?${searchParams.toString()}`;

// --- Crawler Setup ---
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 60,
    maxRequestsPerMinute: 120,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxErrorScore: 2 } },

    preNavigationHooks: [({ request, session }) => {
        const ua = session?.userData?.ua || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${100 + Math.floor(Math.random() * 20)}.0.0.0 Safari/537.36`;
        if (session && !session.userData.ua) session.userData.ua = ua;
        request.headers = {
            ...request.headers,
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        };
        if (cookieHeader) request.headers.Cookie = cookieHeader;
    }],

    failedRequestHandler: ({ request, session }) => {
        if (session) session.retire();
        log.warning(`Request failed, retiring session: ${request.url}`);
    },

    requestHandler: async ({ request, $, crawler, response }) => {
        const { label } = request.userData;
        log.info(`Processing [${label}]: ${request.url}`);
        await sleep(200 + Math.random() * 300);

        if (response.statusCode === 403) throw new Error(`Request blocked with status 403. Try using residential proxies.`);

        if (label === 'LIST') await handleList($, crawler);
        else if (label === 'DETAIL') await handleDetail($, request);
    },
});

// --- Route Handlers ---

async function handleList($, crawler) {
    state.pagesCount++;
    if (getRemainingCapacity() <= 0) {
        log.info('Job limit reached, skipping list page.');
        return;
    }

    const jobElements = $('li.job.job-tile').get();
    if (jobElements.length === 0) {
        log.warning('No job listings found on the page. The page layout may have changed or there are no results for your query.');
        return;
    }

    log.info(`Found ${jobElements.length} jobs on this page.`);

    if (collectDetails) {
        const toEnqueue = [];
        for (const jobElement of jobElements) {
            if (getRemainingCapacity() <= 0) break;
            const jobLink = $(jobElement).find('a.job-link').attr('href');
            const url = getAbsoluteUrl(jobLink);
            if (url) {
                toEnqueue.push({ url, userData: { label: 'DETAIL' } });
                state.enqueuedCount++;
            }
        }
        if (toEnqueue.length > 0) {
            log.info(`Enqueuing ${toEnqueue.length} job detail pages.`);
            await crawler.addRequests(toEnqueue);
        }
    } else {
        // If not collecting details, scrape from the list page itself
        const toPush = [];
        for (const jobElement of jobElements) {
            if (getRemainingCapacity() <= 0) break;
            const title = clean($(jobElement).find('a.job-link').text());
            const url = getAbsoluteUrl($(jobElement).find('a.job-link').attr('href'));
            const company = clean($(jobElement).find('div.job-company').text()); // NOTE: This selector is a guess
            const location = clean($(jobElement).find('div.job-location').text()); // NOTE: This selector is a guess

            toPush.push({ title, company, location, detail_url: url });
            state.jobsCount++;
        }
        if (toPush.length > 0) {
            await Dataset.pushData(toPush);
        }
    }

    // Handle pagination
    if (maxPages && state.pagesCount >= maxPages) {
        log.info(`Max pages limit (${maxPages}) reached. Stopping pagination.`);
        return;
    }

    const nextPageHref = $('a.page-link[rel="next"]').attr('href');
    if (nextPageHref && getRemainingCapacity() > 0) {
        const nextUrl = getAbsoluteUrl(nextPageHref);
        log.info('Enqueuing next list page.');
        await crawler.addRequests([{ url: nextUrl, userData: { label: 'LIST' } }]);
    } else {
        log.info('No next page link found or job limit reached. Ending pagination.');
    }
}

async function handleDetail($, request) {
    if (state.jobsCount >= maxJobs) return;

    const title = clean($('h1.job-title').text());
    const company = clean($('div.company-name').text());
    const jobLocation = clean($('div.job-locations').text());
    const datePosted = clean($('div.job-age').text());

    const descriptionElement = $('div.job-description');
    const description_html = clean(descriptionElement.html());
    const description_text = clean(descriptionElement.text());

    const applyButtonHref = $('#job-apply-button').attr('href');
    const url = getAbsoluteUrl(applyButtonHref);

    await Dataset.pushData({
        title, company, location: jobLocation, date_posted: datePosted,
        description_html, description_text, url, detail_url: request.loadedUrl,
    });

    state.jobsCount++;
    state.enqueuedCount--;
}

// --- Start Crawler ---
log.info(`Starting scrape for keyword "${keyword}"`);
log.info(`Configuration: maxJobs=${maxJobs}, collectDetails=${collectDetails}, maxPages=${maxPages || 'unlimited'}`);

await crawler.run([{
    url: startUrl,
    userData: { label: 'LIST' },
}]);

log.info(`Scraping finished. Scraped ${state.jobsCount} jobs.`);

await Actor.exit();