import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// ---------- Anti-bot pools ----------
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const SEC_CH_UA_POOL = [
    '"Chromium";v="123", "Google Chrome";v="123", "Not;A=Brand";v="99"',
    '"Not.A/Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"',
];

const ACCEPT_LANG_POOL = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en;q=0.8'];

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs + 1)); }

// ---------- Inputs ----------
await Actor.init();
const {
    results_wanted = 100,
    maxPagesPerList = 20,
    maxConcurrency = 6,
    proxyConfiguration,
    startUrls = [
        'https://www.flexjobs.com/remote-jobs',
    ],
    cookies = [],
} = await Actor.getInput() || {};

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

let pushedCount = 0;

// ---------- Utility functions (meta extraction & description cleaning) ----------
function findMetaList($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main') : $('main').first();

    let $meta = $main.find('ul').filter((_, ul) => {
        return $(ul).find('h5').filter((__, h5) => {
            const t = $(h5).text().trim().toLowerCase();
            return /remote level|location|salary|benefits|job type|job schedule|career level|company/.test(t);
        }).length > 0;
    }).first();

    return $meta.length ? $meta : null;
}

function extractMetaMap($) {
    const $meta = findMetaList($);
    const map = {};
    if (!$meta) return map;

    $meta.children('li').each((_, li) => {
        const $li = $(li);
        const rawLabel = $li.find('h5').first().text().replace(':', '').trim().toLowerCase();
        const value = $li.find('p').first().text().trim().replace(/\s+/g, ' ');
        if (!rawLabel) return;
        if (rawLabel.includes('remote level')) map.remote_level = value;
        else if (rawLabel === 'location') map.location = value;
        else if (rawLabel === 'salary') map.salary = value;
        else if (rawLabel === 'benefits') map.benefits = value;
        else if (rawLabel === 'job type') map.job_type = value;
        else if (rawLabel === 'job schedule') map.schedule = value;
        else if (rawLabel === 'career level') map.career_level = value;
        else if (rawLabel === 'company') map.company = value;
    });

    return map;
}

function cleanDescription($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main').clone() : $('main').first().clone();
    if (!$main.length) return { html: null, text: null };

    $main.find('ul.page-breadcrumb, .unlock-lock, .similar-jobs, script, style').remove();

    const $meta = findMetaList($);
    let $descScope = $meta ? $meta.parent().nextAll().clone() : $main.clone();

    $descScope.find('a, button, svg, img, form').remove();
    $descScope.find('*').each((_, el) => { el.attribs = {}; });
    $descScope.find('*').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        if (!['p','ul','li','br','strong','em'].includes(tag)) {
            $(el).replaceWith($(el).html() || '');
        }
    });

    let html = $descScope.html()?.trim() || null;
    if (html) {
        html = html.replace(/<\/?(div|span|button|i)[^>]*>/gi, '').trim();
    }

    const text = html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html, text };
}

function detectBlocking(response, session, url) {
    const status = response?.statusCode;
    if (status === 403 || status === 429) {
        log.warning(`Blocked with status ${status} on ${url}`);
        if (session) session.markBad();
        const err = new Error(`Request blocked - ${status}`);
        err.statusCode = status;
        throw err;
    }
}

// ---------- Crawler ----------
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    useSessionPool: true,
    maxConcurrency,
    maxRequestRetries: 5,

    preNavigationHooks: [
        async ({ request }) => {
            const ua = randFrom(USER_AGENTS);
            const secChUa = randFrom(SEC_CH_UA_POOL);
            const acceptLang = randFrom(ACCEPT_LANG_POOL);

            const headers = {
                'User-Agent': ua,
                'Accept-Language': acceptLang,
                'Sec-CH-UA': secChUa,
                'Referer': 'https://www.flexjobs.com/remote-jobs',
                'Connection': 'keep-alive',
            };

            if (cookies.length) {
                headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }

            request.headers = { ...(request.headers || {}), ...headers };

            // add random delay to look human
            await Actor.sleep(jitter(500, 2000));
        },
    ],

    async requestHandler({ request, $, response, session, enqueueLinks }) {
        detectBlocking(response, session, request.loadedUrl);

        if (request.userData.label === 'LIST') {
            await enqueueLinks({ selector: 'a[href*="/publicjobs/"]', label: 'DETAIL' });

            const next = $('a[rel="next"]').attr('href');
            if (next) {
                const abs = new URL(next, request.loadedUrl).href;
                await enqueueLinks({ urls: [abs], label: 'LIST' });
            }
            return;
        }

        if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) return;

            const title = $('h1').first().text().trim();
            const meta = extractMetaMap($);

            let company = meta.company;
            if (company && /details here/i.test(company)) company = null;

            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: meta.remote_level || null,
                location: meta.location || null,
                salary: meta.salary || null,
                benefits: meta.benefits || null,
                job_type: meta.job_type || null,
                schedule: meta.schedule || null,
                career_level: meta.career_level || null,
                company,
                scraped_at: new Date().toISOString(),
            };

            const desc = cleanDescription($);
            job.description_html = desc.html;
            job.description_text = desc.text;

            await Actor.pushData(job);
            pushedCount++;
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request ${request.url} failed. Error: ${error.message}`);
    },
});

await crawler.run(startUrls.map(url => ({ url, userData: { label: 'LIST' } })));
await Actor.exit();
