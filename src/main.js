import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const {
    results_wanted = 100,
    maxPagesPerList = 20,
    maxConcurrency = 10,
    proxyConfiguration,
    startUrls = [
        'https://www.flexjobs.com/remote-jobs',
        'https://www.flexjobs.com/remote-jobs/legitimate-work-from-home-jobs-hiring-now'
    ],
    cookies = []
} = await Actor.getInput() || {};

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// --- Helpers ---

function getField($, label, idAttr) {
    // Priority: ID attribute
    if (idAttr) {
        const el = $(`li#${idAttr} p`).first();
        if (el.length) return el.text().trim().replace(/\s+/g, ' ');
    }
    // Fallback: label text
    const el = $(`li:has(h5:contains("${label}")) p`).first();
    if (el.length) return el.text().trim().replace(/\s+/g, ' ');
    return null;
}

function cleanDescription($) {
    // Target main job body
    let $desc = $('main .sc-1d24dx7-2, main section, main article').first().clone();

    if (!$desc.length) return { html: null, text: null };

    // Remove unwanted UI blocks
    $desc.find('a, nav, ul.page-breadcrumb, .unlock-lock, .similar-jobs, script, style, button, svg, img').remove();

    // Strip attributes
    $desc.find('*').each((_, el) => {
        el.attribs = {};
    });

    // Keep only safe tags
    $desc.find('*').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        if (!['p', 'ul', 'li', 'br', 'strong', 'em'].includes(tag)) {
            $(el).replaceWith($(el).html() || '');
        }
    });

    // Remove empty tags
    $desc.find('*').each((_, el) => {
        if (!$(el).text().trim()) $(el).remove();
    });

    let html = $desc.html() ? $desc.html().trim() : null;
    let text = $desc.text().trim();

    // Regex cleanup for FlexJobs marketing & stray div/button endings
    const cleanupRegex = /(Unlock this job[\s\S]*?jobs)|Find Your Next Remote Job!?|Only hand-screened, legit jobs|No ads, scams, or junk|Expert resources, webinars & events|<\/?div>|<\/?button>|<\/?i>/gi;
    if (html) html = html.replace(cleanupRegex, '');
    if (text) text = text.replace(cleanupRegex, '');

    return { html, text };
}

// --- Crawler ---

let pushedCount = 0;

const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency,
    useSessionPool: true,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 60,

    preNavigationHooks: [
        async ({}, gotoOptions) => {
            if (cookies && cookies.length) {
                const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                gotoOptions.headers = {
                    ...(gotoOptions.headers || {}),
                    Cookie: cookieHeader,
                };
            }
        }
    ],

    async requestHandler({ request, $, enqueueLinks }) {
        if (request.userData.label === 'LIST') {
            // Enqueue job detail pages
            await enqueueLinks({
                selector: 'a[href*="/publicjobs/"]',
                label: 'DETAIL',
                transformRequestFunction: req => {
                    req.userData.label = 'DETAIL';
                    return req;
                },
            });

            // Pagination
            let nextUrl = $('a[rel="next"]').attr('href')
                || $('a:contains("Next")').attr('href')
                || $('a:contains("Older")').attr('href');

            if (nextUrl) {
                await enqueueLinks({ urls: [new URL(nextUrl, request.loadedUrl).href], label: 'LIST' });
            } else {
                const m = request.loadedUrl.match(/page=(\d+)/);
                let page = m ? parseInt(m[1], 10) : 1;
                if (page < maxPagesPerList) {
                    const sep = request.loadedUrl.includes('?') ? '&' : '?';
                    const nextSynthetic = request.loadedUrl.replace(/([?&])page=\d+/, `$1page=${page + 1}`);
                    const finalUrl = nextSynthetic === request.loadedUrl
                        ? `${request.loadedUrl}${sep}page=${page + 1}`
                        : nextSynthetic;
                    await enqueueLinks({ urls: [finalUrl], label: 'LIST' });
                }
            }
        }

        else if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) return;

            const title = $('h1').first().text().trim();

            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                remote_level: getField($, 'Remote Level', 'remote-work-level'),
                location: getField($, 'Location', 'location'),
                salary: getField($, 'Salary', 'salary'),
                benefits: getField($, 'Benefits', 'benefits'),
                job_type: getField($, 'Job Type', 'job-type'),
                schedule: getField($, 'Job Schedule', 'job-schedule'),
                career_level: getField($, 'Career Level', 'career-level'),
                company: (() => {
                    const val = getField($, 'Company', 'company');
                    if (!val || /details here/i.test(val)) return null;
                    return val;
                })(),
                scraped_at: new Date().toISOString(),
            };

            // Description cleaning
            const desc = cleanDescription($);
            job.description_html = desc.html;
            job.description_text = desc.text;

            await Actor.pushData(job);
            pushedCount++;
        }
    },

    failedRequestHandler({ request }) {
        log.error(`Request ${request.url} failed too many times`);
    },
});

await crawler.run(startUrls.map(url => ({ url, userData: { label: 'LIST' } })));

await Actor.exit();
