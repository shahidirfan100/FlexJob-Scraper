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
        else if (rawLabel === 'job type') map.job_type = value || null;
        else if (rawLabel === 'job schedule') map.schedule = value || null;
        else if (rawLabel === 'career level') map.career_level = value || null;
        else if (rawLabel === 'company') map.company = value || null;
    });

    return map;
}

function normalizeCleanText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text;
}

function extractCompanyName($, meta, jp) {
    const seen = new Set();
    const add = (value) => {
        const clean = normalizeCleanText(value);
        if (!clean) return;
        const lowered = clean.toLowerCase();
        if (lowered.includes('flexjobs') && lowered.replace(/flexjobs/ig, '').length === 0) return;
        if (/details here/i.test(clean)) return;
        if (/similar jobs/i.test(clean)) return;
        if (!seen.has(lowered)) seen.add(lowered);
    };

    add(meta.company);

    const org = jp?.hiringOrganization;
    if (Array.isArray(org)) {
        for (const item of org) {
            add(item?.name);
            add(item?.legalName);
        }
    } else if (org) {
        add(org.name);
        add(org.legalName);
        if (typeof org === 'string') add(org);
        const identifier = org.identifier;
        if (Array.isArray(identifier)) {
            for (const ident of identifier) add(ident?.name);
        } else if (identifier) add(identifier?.name);
    }

    const selectors = [
        '.job-view__company-name',
        '.job-view__company a',
        '.job-company',
        '.job-company a',
        '.job-details__company',
        '.job-details__meta li:contains("Company")',
        '.job-overview__company',
        '.job-header__company',
        '.job-header__company a',
        '.job-top__meta a[href*="company"]',
        '.job-top__meta [data-company-name]',
        'a[href*="/company-profile/"]',
        'a[href*="/companies/"]',
        '[data-testid="company-name"]',
        '[data-test="company-name"]',
        '[data-qa="company-name"]',
        '[itemprop="hiringOrganization"] [itemprop="name"]',
    ];

    for (const selector of selectors) {
        const $el = $(selector).first();
        if (!$el.length) continue;
        add($el.attr('data-company'));
        add($el.attr('data-company-name'));
        add($el.attr('title'));
        add($el.text());
        const nested = $el.find('strong, span, a').first();
        if (nested.length) add(nested.text());
    }

    const candidates = Array.from(seen.values());
    return candidates.length ? candidates[0] : null;
}

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
        } catch (_) {}
    }

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
        const jl = jobPosting.jobLocation;
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

        if (jobPosting.jobLocationType && /telecommute/i.test(jobPosting.jobLocationType)) return 'Remote';
        return null;
    } catch {
        return null;
    }
}

function isMeaningfulDescription(text) {
    if (!text) return false;
    const stripped = text.replace(/\s+/g, ' ').trim();
    if (!stripped) return false;
    if (/^similar jobs$/i.test(stripped)) return false;
    if (stripped.length < 60) return false;
    return true;
}

function cleanHtmlFragment(html) {
    if (!html) return { html: null, text: null };
    const cheerio = require('cheerio');
    const $$ = cheerio.load(String(html));

    $$('a, script, style, button, svg, img, form, nav, header, footer, aside').remove();
    $$('*').each((_, el) => { el.attribs = {}; });

    $$('*').each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (!['p','ul','ol','li','br','strong','em','h2','h3','h4','h5'].includes(tag)) {
            $$(el).replaceWith($$(el).html() || '');
        }
    });

    $$('*').each((_, el) => {
        const $el = $$(el);
        if (!$el.text().trim() && !$el.find('br').length) $el.remove();
    });

    let cleaned = $$.root().html()?.trim() || null;
    if (cleaned) {
        cleaned = cleaned.replace(/<\/?(div|span|button|i)[^>]*>/gi, '').replace(/&nbsp;/gi, ' ').trim();
    }

    const text = cleaned ? cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    return { html: cleaned, text };
}

function cleanSection($section) {
    if (!$section || !$section.length) return { html: null, text: null };
    const $clone = $section.clone();
    $clone.find('.unlock-lock, [class*="similar"], [id*="similar"], script, style, nav, header, footer, aside').remove();
    $clone.find('h2:contains("Similar Jobs"), h3:contains("Similar Jobs"), h4:contains("Similar Jobs")').each((_, el) => {
        const $el = $clone.find(el);
        $el.nextUntil('h1,h2,h3,h4').remove();
        $el.remove();
    });
    const cleaned = cleanHtmlFragment($clone.html());
    if (!cleaned) return { html: null, text: null };

    let { html, text } = cleaned;
    if (html) {
        html = html.replace(/<h[2-5][^>]*>\s*Similar Jobs\s*<\/h[2-5]>/gi, '').trim() || null;
    }
    if (text) {
        text = text.replace(/\bSimilar Jobs\b/gi, ' ').replace(/\s+/g, ' ').trim() || null;
    }

    if (!isMeaningfulDescription(text)) return { html: null, text: null };
    return { html, text };
}

function extractDescription($, jp) {
    if (jp?.description) {
        const cheerio = require('cheerio');
        const wrap = cheerio.load('<div>' + jp.description + '</div>');
        const fromJsonLd = cleanSection(wrap('div'));
        if (isMeaningfulDescription(fromJsonLd.text)) return fromJsonLd;
    }

    const selectors = [
        '[data-testid="job-description"]',
        '[data-test="job-description"]',
        '[data-qa="job-description"]',
        '.job-description',
        '.job-description__body',
        '.job-description__content',
        '.job-view__description',
        '.job-view__body',
        '.job-details__description',
        '.job-details__body',
        '#job-description',
        'article.job-description',
    ];

    for (const selector of selectors) {
        const $el = $(selector).first();
        const cleaned = cleanSection($el);
        if (isMeaningfulDescription(cleaned.text)) return cleaned;
    }

    const heading = $('h2, h3, h4').filter((_, el) => /job description|about the role|what you will do|responsibilities|what you'll do/i.test($(el).text())).first();
    if (heading.length) {
        const $container = $('<div></div>');
        let $next = heading.next();
        while ($next.length && !$next.is('h1, h2, h3')) {
            $container.append($next.clone());
            $next = $next.next();
        }
        const cleaned = cleanSection($container);
        if (isMeaningfulDescription(cleaned.text)) return cleaned;
    }

    const $main = $('main').first();
    const cleaned = cleanSection($main);
    if (isMeaningfulDescription(cleaned.text)) return cleaned;

    return { html: null, text: null };
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
            log.debug(`🟢 Preparing request: ${request.url}`);
            const delay = jitter(500, 2000);
            await sleep(delay);
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

            const title = $('h1').first().text().trim() || null;
            const meta = extractMetaMap($);
            const jp = parseJsonLd($);

            // --- Company ---
            const company = extractCompanyName($, meta, jp);

            // --- Job type / schedule ---
            const job_type = meta.job_type ?? null;
            let schedule = meta.schedule ?? null;
            if (!schedule && jp?.employmentType) schedule = normalizeEmploymentType(jp.employmentType);

            // --- Location ---
            let location = meta.location ?? null;
            if (!location && jp) location = locationFromJsonLd(jp);
            if (location) location = location.replace(/\s+/g, ' ').trim();

            // --- Description ---
            const { html: descHtml, text: descText } = extractDescription($, jp);

            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: meta.remote_level ?? null,
                location: location || null,
                salary: meta.salary ?? null,
                benefits: meta.benefits ?? null,
                job_type,
                schedule,
                career_level: meta.career_level ?? null,
                company: company || null,
                description_html: descHtml || null,
                description_text: descText || null,
                scraped_at: new Date().toISOString(),
            };

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
