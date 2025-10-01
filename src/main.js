import { Actor } from 'apify';
import { CheerioCrawler, log, sleep } from 'crawlee';

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

// ---------- Helpers ----------
function findMetaList($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main') : $('main').first();

    let $meta = $main.find('ul').filter((_, ul) => {
        return $(ul).find('h5').filter((__, h5) => {
            const t = $(h5).text().trim().toLowerCase();
            return /remote level|location|salary|benefits|job type|job schedule|career level|company/.test(t);
        }).length > 0;
    }).first();

    if (!$meta.length) return null;
    return $meta;
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

        if (rawLabel.includes('remote level')) map.remote_level = value || null;
        else if (rawLabel === 'location') map.location = value || null;
        else if (rawLabel === 'salary') map.salary = value || null;
        else if (rawLabel === 'benefits') map.benefits = value || null;
        else if (rawLabel === 'job type') map.job_type = value || null;      // e.g., Employee, Contract, Freelance
        else if (rawLabel === 'job schedule') map.schedule = value || null;  // e.g., Full-Time, Part-Time
        else if (rawLabel === 'career level') map.career_level = value || null;
        else if (rawLabel === 'company') map.company = value || null;
    });

    return map;
}

// --- JSON-LD helpers (NEW) ---
function parseJsonLd($) {
    const scripts = Array.from($('script[type="application/ld+json"]'));
    const docs = [];
    for (const s of scripts) {
        try {
            const raw = $(s).contents().text();
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) docs.push(...parsed);
            else docs.push(parsed);
        } catch (_) {
            // ignore invalid JSON-LD blocks
        }
    }

    // Find first JobPosting in graph/array/object
    function extractJobPosting(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const t = (obj['@type'] || obj.type || '').toString().toLowerCase();
        if (t === 'jobposting') return obj;
        if (obj['@graph'] && Array.isArray(obj['@graph'])) {
            return obj['@graph'].map(extractJobPosting).find(Boolean) || null;
        }
        return null;
    }

    for (const doc of docs) {
        const jp = extractJobPosting(doc);
        if (jp) return jp;
    }
    return null;
}

function normalizeEmploymentType(val) {
    if (!val) return null;
    if (Array.isArray(val)) val = val.join(', ');
    // Common encodings to friendly labels
    return String(val)
        .replace(/FULL[_\s-]?TIME/ig, 'Full-Time')
        .replace(/PART[_\s-]?TIME/ig, 'Part-Time')
        .replace(/CONTRACTOR?/ig, 'Contract')
        .replace(/TEMP(ORARY)?/ig, 'Temporary')
        .replace(/INTERNSHIP?/ig, 'Internship')
        .replace(/FREELANCE/ig, 'Freelance')
        .trim();
}

function locationFromJsonLd(jobPosting) {
    try {
        if (!jobPosting) return null;

        // Remote hint
        if (jobPosting.jobLocationType && /telecommute/i.test(jobPosting.jobLocationType)) {
            // leave as "Remote" if no address
            // If country present, combine: "Remote, US"
        }

        const jl = jobPosting.jobLocation;
        if (!jl) return jobPosting.jobLocationType ? 'Remote' : null;

        const pickAddr = (locObj) => {
            const addr = locObj?.address || {};
            const parts = [
                addr.addressLocality,
                addr.addressRegion,
                addr.addressCountry,
            ].filter(Boolean);
            return parts.length ? parts.join(', ') : null;
        };

        if (Array.isArray(jl)) {
            for (const loc of jl) {
                const s = pickAddr(loc);
                if (s) return s;
            }
        } else {
            const s = pickAddr(jl);
            if (s) return s;
        }

        // Fallback to jobLocationType only
        if (jobPosting.jobLocationType) return /telecommute/i.test(jobPosting.jobLocationType) ? 'Remote' : null;
        return null;
    } catch {
        return null;
    }
}

// Prefer JSON-LD description if present; clean it
function cleanHtmlFragment(html) {
    if (!html) return { html: null, text: null };
    const cheerio = require('cheerio');
    const $$ = cheerio.load(String(html));

    // Remove anchors completely
    $$('a, script, style, button, svg, img, form, nav, header, footer, aside').remove();

    // Strip attributes
    $$('*').each((_, el) => { el.attribs = {}; });

    // Allowlist
    $$('*').each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (!['p','ul','li','br','strong','em','h2','h3','h4'].includes(tag)) {
            $$(el).replaceWith($$(el).html() || '');
        }
    });

    // Remove empties
    $$('*').each((_, el) => {
        const $el = $$(el);
        if (!$el.text().trim() && !$el.find('br').length) $el.remove();
    });

    let cleaned = $$.root().html()?.trim() || null;
    if (cleaned) {
        cleaned = cleaned
            .replace(/<\/?(div|span|button|i)[^>]*>/gi, '')
            .replace(/&nbsp;/gi, ' ')
            .trim();
    }

    const text = cleaned ? cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html: cleaned, text };
}

function cleanDescriptionFromDom($) {
    const $h1 = $('h1').first();
    const $main = $h1.length ? $h1.closest('main').clone() : $('main').first().clone();
    if (!$main.length) return { html: null, text: null };

    $main.find('ul.page-breadcrumb, .unlock-lock, .similar-jobs, script, style, nav, header, footer, aside').remove();

    const $meta = findMetaList($);
    let $descScope;
    if ($meta && $meta.length) {
        $descScope = $meta.parent().nextAll().clone();
    }
    if (!$descScope || !$descScope.length) $descScope = $main.clone();

    $descScope.find('a, button, svg, img, form').remove();
    $descScope.find('*').each((_, el) => { el.attribs = {}; });
    $descScope.find('*').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        if (!['p','ul','li','br','strong','em','h2','h3','h4'].includes(tag)) {
            $(el).replaceWith($(el).html() || '');
        }
    });

    $descScope.find('*').each((_, el) => {
        const $el = $(el);
        if (!$el.text().trim() && !$el.find('br').length) $el.remove();
    });

    let html = $descScope.html()?.trim() || null;
    if (html) {
        html = html
            .replace(/<\/?(div|span|button|i)[^>]*>/gi, '')
            .replace(/&nbsp;/gi, ' ')
            .trim();
    }

    const text = html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html, text };
}

function detectBlocking(response, session, url) {
    const status = response?.statusCode;
    if (status === 403 || status === 429) {
        log.warning(`⚠️ Blocked with status ${status} on ${url}`);
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
        async ({ request, session }) => {
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

            // 🔎 Debug logs
            log.debug(`🟢 Preparing request: ${request.url}`);
            log.debug(`   Session: ${session?.id || 'N/A'}`);
            log.debug(`   UA: ${ua}`);
            log.debug(`   Cookie: ${headers.Cookie ? headers.Cookie.slice(0, 80) + '...' : 'None'}`);

            // random delay
            const delay = jitter(500, 2000);
            log.debug(`   Sleeping for ${delay} ms before request`);
            await sleep(delay);
        },
    ],

    async requestHandler({ request, $, response, session, enqueueLinks }) {
        detectBlocking(response, session, request.loadedUrl);

        log.info(`📄 Processing ${request.userData.label || 'UNKNOWN'} page: ${request.loadedUrl}`);

        if (request.userData.label === 'LIST') {
            await enqueueLinks({ selector: 'a[href*="/publicjobs/"]', label: 'DETAIL' });

            const next = $('a[rel="next"]').attr('href');
            if (next) {
                const abs = new URL(next, request.loadedUrl).href;
                log.debug(`   Found next page: ${abs}`);
                await enqueueLinks({ urls: [abs], label: 'LIST' });
            }
            return;
        }

        if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) return;

            const title = $('h1').first().text().trim() || null;

            // 1) On-page metadata (authoritative for job_type vs schedule)
            const meta = extractMetaMap($);

            // 2) JSON-LD fallback (NEW): for company, schedule, location, description
            const jp = parseJsonLd($);
            if (jp) log.debug('   JSON-LD JobPosting found.');

            // company: prefer on-page meta; if masked/null, try JSON-LD
            let company = meta.company || null;
            if (company && /details here/i.test(company)) company = null;
            if (!company && jp?.hiringOrganization?.name) {
                company = String(jp.hiringOrganization.name).trim() || null;
                if (company) log.debug(`   Company filled from JSON-LD: ${company}`);
            }

            // job_type vs schedule: NEVER swap.
            // - job_type only from on-page "Job Type" (Employee / Contract / Freelance).
            // - schedule from on-page "Job Schedule"; if missing, fallback to JSON-LD employmentType.
            const job_type = meta.job_type ?? null;
            let schedule = meta.schedule ?? null;
            if (!schedule && jp?.employmentType) {
                const norm = normalizeEmploymentType(jp.employmentType);
                if (norm) {
                    schedule = norm;
                    log.debug(`   Schedule filled from JSON-LD employmentType: ${schedule}`);
                }
            }

            // location: prefer on-page; if missing/empty, fallback to JSON-LD address
            let location = meta.location ?? null;
            if (!location && jp) {
                const ldLoc = locationFromJsonLd(jp);
                if (ldLoc) {
                    location = ldLoc;
                    log.debug(`   Location filled from JSON-LD: ${location}`);
                }
            }
            if (location) location = location.replace(/\s+/g, ' ').trim();

            // description: prefer JSON-LD description; fallback to DOM cleaner
            let descHtml = null, descText = null;
            if (jp?.description) {
                const cleaned = cleanHtmlFragment(jp.description);
                descHtml = cleaned.html;
                descText = cleaned.text;
                if (descHtml || descText) log.debug('   Description taken from JSON-LD.');
            }
            if (!descHtml && !descText) {
                const d2 = cleanDescriptionFromDom($);
                descHtml = d2.html;
                descText = d2.text;
                if (descHtml || descText) log.debug('   Description taken from DOM fallback.');
            }

            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: meta.remote_level ?? null,
                location: location || null,
                salary: meta.salary ?? null,
                benefits: meta.benefits ?? null,
                job_type,                  // <-- stays job_type (Employee/Contract/Freelance)
                schedule,                  // <-- stays schedule (Full-Time/Part-Time), may come from JSON-LD
                career_level: meta.career_level ?? null,
                company: company || null,
                description_html: descHtml || null,
                description_text: descText || null,
                scraped_at: new Date().toISOString(),
            };

            log.debug(`   Extracted job: ${JSON.stringify(job, null, 2).slice(0, 600)}...`);

            await Actor.pushData(job);
            pushedCount++;
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`❌ Request ${request.url} failed. Error: ${error.message}`);
    },
});

// Seed
await crawler.run(startUrls.map(url => ({ url, userData: { label: 'LIST' } })));
await Actor.exit();
