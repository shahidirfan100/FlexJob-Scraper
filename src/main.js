import { Actor } from 'apify';
import { CheerioCrawler, log, sleep } from 'crawlee';

// ---------- Configuration ----------
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs + 1)); }

// ---------- Initialize ----------
await Actor.init();
const input = await Actor.getInput() || {};
const {
    results_wanted = 100,
    maxConcurrency = 3,
    proxyConfiguration,
    startUrls = ['https://www.flexjobs.com/remote-jobs'],
    cookies = [],
    debugMode = false,
} = input;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
let pushedCount = 0;
let processedUrls = new Set();

// ---------- Core Extraction Functions ----------

/**
 * CRITICAL FIX #1: FlexJobs uses a specific meta list structure
 * The original code failed because it looked for h5 tags, but FlexJobs might use different tags
 */
function extractJobMeta($) {
    const meta = {};
    
    // Strategy 1: Look for dl/dt/dd structure (definition list)
    $('dl').each((_, dl) => {
        const $dl = $(dl);
        $dl.find('dt').each((__, dt) => {
            const $dt = $(dt);
            const $dd = $dt.next('dd');
            if (!$dd.length) return;
            
            const label = $dt.text().trim().toLowerCase().replace(/[:：]/g, '');
            const value = $dd.text().trim().replace(/\s+/g, ' ');
            
            assignMetaValue(meta, label, value);
        });
    });
    
    // Strategy 2: Look for ul > li structure with various label patterns
    $('ul').each((_, ul) => {
        const $ul = $(ul);
        const ulText = $ul.text().toLowerCase();
        
        // Only process if it looks like job metadata
        if (!/remote|location|salary|company|job type|career|schedule/i.test(ulText)) {
            return;
        }
        
        $ul.find('li').each((__, li) => {
            const $li = $(li);
            
            // Method A: Label in h5/h6/strong/b tag, value in p/span/div
            const $label = $li.find('h5, h6, strong, b, .label, [class*="label"]').first();
            if ($label.length) {
                const label = $label.text().trim().toLowerCase().replace(/[:：]/g, '');
                // Get value from sibling or next element
                let value = $li.find('p, span:not(:has(strong)):not(:has(b))').first().text().trim();
                if (!value) {
                    // Try getting all text and removing label
                    value = $li.text().replace($label.text(), '').trim();
                }
                value = value.replace(/^[:：\s]+/, '').replace(/\s+/g, ' ');
                assignMetaValue(meta, label, value);
            } else {
                // Method B: First line is label, rest is value
                const text = $li.text().trim();
                const parts = text.split(/[:：]/);
                if (parts.length >= 2) {
                    const label = parts[0].trim().toLowerCase();
                    const value = parts.slice(1).join(':').trim().replace(/\s+/g, ' ');
                    assignMetaValue(meta, label, value);
                }
            }
        });
    });
    
    // Strategy 3: Div-based metadata (common in modern sites)
    $('[class*="meta"], [class*="info"], [class*="details"]').each((_, el) => {
        const $el = $(el);
        $el.find('[class*="item"], [class*="field"]').each((__, item) => {
            const $item = $(item);
            const labelEl = $item.find('[class*="label"], [class*="key"]').first();
            const valueEl = $item.find('[class*="value"]').first();
            
            if (labelEl.length && valueEl.length) {
                const label = labelEl.text().trim().toLowerCase().replace(/[:：]/g, '');
                const value = valueEl.text().trim().replace(/\s+/g, ' ');
                assignMetaValue(meta, label, value);
            }
        });
    });
    
    if (debugMode) {
        log.info('📋 Extracted metadata:', JSON.stringify(meta, null, 2));
    }
    
    return meta;
}

function assignMetaValue(meta, label, value) {
    if (!label || !value) return;
    
    if (/remote\s*level|remote\s*type|remote\s*option/i.test(label)) {
        meta.remote_level = value;
    } else if (/^location$|^where$/i.test(label)) {
        meta.location = value;
    } else if (/salary|compensation|pay|wage/i.test(label)) {
        meta.salary = value;
    } else if (/benefit/i.test(label)) {
        meta.benefits = value;
    } else if (/job\s*type|employment\s*type|position\s*type/i.test(label)) {
        meta.job_type = value;
    } else if (/schedule|hours|time/i.test(label)) {
        meta.schedule = value;
    } else if (/career\s*level|experience\s*level|seniority/i.test(label)) {
        meta.career_level = value;
    } else if (/company|employer|organization|hiring/i.test(label)) {
        meta.company = value;
    }
}

/**
 * CRITICAL FIX #2: Better JSON-LD extraction
 * FlexJobs heavily relies on structured data
 */
function extractJsonLd($) {
    const jsonLdData = [];
    
    $('script[type="application/ld+json"]').each((_, script) => {
        try {
            const content = $(script).html();
            if (!content) return;
            
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                jsonLdData.push(...parsed);
            } else {
                jsonLdData.push(parsed);
            }
        } catch (e) {
            if (debugMode) log.debug('JSON-LD parse error:', e.message);
        }
    });
    
    // Find JobPosting
    for (const data of jsonLdData) {
        if (data['@type'] === 'JobPosting') {
            return data;
        }
        if (data['@graph']) {
            const jobPosting = data['@graph'].find(item => item['@type'] === 'JobPosting');
            if (jobPosting) return jobPosting;
        }
    }
    
    return null;
}

/**
 * CRITICAL FIX #3: Company extraction with multiple fallbacks
 */
function extractCompany($, meta, jsonLd) {
    // Priority order for company extraction
    const candidates = [];
    
    // 1. From metadata
    if (meta.company) {
        candidates.push(meta.company);
    }
    
    // 2. From JSON-LD
    if (jsonLd) {
        const org = jsonLd.hiringOrganization;
        if (org) {
            if (typeof org === 'string') {
                candidates.push(org);
            } else if (org.name) {
                candidates.push(org.name);
            } else if (org.legalName) {
                candidates.push(org.legalName);
            }
        }
    }
    
    // 3. From CSS selectors - UPDATED FOR FLEXJOBS
    const selectors = [
        'a[href*="/company/"]',
        'a[href*="/companies/"]',
        'a[href*="/company-profile/"]',
        '[data-company-name]',
        '[itemprop="hiringOrganization"] [itemprop="name"]',
        '.company-name',
        '.job-company',
        '[class*="company-name"]',
        'h2 a[href*="company"]',
    ];
    
    for (const selector of selectors) {
        const $el = $(selector).first();
        if ($el.length) {
            const text = $el.text().trim();
            if (text && text.length > 0 && text.length < 100) {
                candidates.push(text);
            }
        }
    }
    
    // Clean and return first valid candidate
    for (const candidate of candidates) {
        const clean = candidate.replace(/\s+/g, ' ').trim();
        // Filter out non-company strings
        if (clean.length < 2 || clean.length > 100) continue;
        if (/^(flexjobs|apply|view|similar|jobs?)$/i.test(clean)) continue;
        if (clean.toLowerCase().includes('flexjobs') && clean.toLowerCase().replace('flexjobs', '').trim().length === 0) continue;
        return clean;
    }
    
    return null;
}

/**
 * CRITICAL FIX #4: Description extraction with better cleaning
 */
function extractDescription($, jsonLd) {
    // Try JSON-LD first
    if (jsonLd?.description) {
        const text = jsonLd.description.replace(/\s+/g, ' ').trim();
        if (text.length > 100) {
            return {
                text,
                html: `<p>${text}</p>`,
            };
        }
    }
    
    // CSS selector strategies
    const selectors = [
        // Modern data attributes
        '[data-job-description]',
        '[data-description]',
        // Class-based
        '.job-description',
        '.description',
        '.job-content',
        '.job-detail-content',
        '[class*="description"]',
        // ID-based
        '#job-description',
        '#description',
        // Semantic
        'article .content',
        'main .content',
    ];
    
    for (const selector of selectors) {
        const $el = $(selector).first();
        if (!$el.length) continue;
        
        const $cleaned = cleanDescriptionElement($el.clone(), $);
        const html = $cleaned.html();
        const text = $cleaned.text().replace(/\s+/g, ' ').trim();
        
        if (text.length > 100 && !text.toLowerCase().includes('similar jobs')) {
            return { html, text };
        }
    }
    
    // Fallback: Look for heading-based sections
    const $heading = $('h2, h3').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return /job description|about (the|this) (role|position|job)|overview|responsibilities/i.test(text);
    }).first();
    
    if ($heading.length) {
        const $container = $('<div></div>');
        let $current = $heading.next();
        
        while ($current.length && !$current.is('h1, h2, h3')) {
            $container.append($current.clone());
            $current = $current.next();
        }
        
        const $cleaned = cleanDescriptionElement($container, $);
        const html = $cleaned.html();
        const text = $cleaned.text().replace(/\s+/g, ' ').trim();
        
        if (text.length > 100) {
            return { html, text };
        }
    }
    
    return { html: null, text: null };
}

function cleanDescriptionElement($el, $) {
    // Remove unwanted elements
    $el.find('script, style, nav, header, footer, aside, button, form').remove();
    $el.find('[class*="similar"], [id*="similar"], [class*="related"]').remove();
    $el.find('a').replaceWith(function() {
        return $(this).text();
    });
    
    // Remove empty elements
    $el.find('*').each((_, el) => {
        const $elem = $(el);
        if (!$elem.text().trim() && !$elem.find('br, img').length) {
            $elem.remove();
        }
    });
    
    return $el;
}

/**
 * CRITICAL FIX #5: Better URL detection for job listings
 */
function extractJobUrls($, baseUrl) {
    const urls = new Set();
    
    // Multiple patterns for FlexJobs
    const patterns = [
        'a[href*="/publicjobs/"]',
        'a[href*="/remote-jobs/"][href*="-job-"]',
        'a[href*="/job/"]',
        'a.job-link',
        'a[class*="job-title"]',
        '[data-job-url]',
    ];
    
    for (const pattern of patterns) {
        $(pattern).each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            
            try {
                const absolute = new URL(href, baseUrl).href;
                // Validate it looks like a job URL
                if (absolute.includes('flexjobs.com') && 
                    (absolute.includes('/publicjobs/') || 
                     absolute.includes('-job-') ||
                     absolute.includes('/job/'))) {
                    urls.add(absolute);
                }
            } catch (e) {
                // Invalid URL
            }
        });
    }
    
    return Array.from(urls);
}

/**
 * CRITICAL FIX #6: Location extraction from JSON-LD
 */
function extractLocation(meta, jsonLd) {
    // From metadata
    if (meta.location) return meta.location;
    
    // From JSON-LD
    if (jsonLd) {
        const jobLocation = jsonLd.jobLocation;
        
        if (Array.isArray(jobLocation)) {
            const locations = jobLocation.map(loc => {
                if (typeof loc === 'string') return loc;
                const addr = loc.address || {};
                return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
                    .filter(Boolean).join(', ');
            }).filter(Boolean);
            if (locations.length > 0) return locations[0];
        } else if (typeof jobLocation === 'object') {
            const addr = jobLocation.address || {};
            const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry];
            const location = parts.filter(Boolean).join(', ');
            if (location) return location;
        } else if (typeof jobLocation === 'string') {
            return jobLocation;
        }
        
        // Check for remote
        if (jsonLd.jobLocationType && /telecommute/i.test(jsonLd.jobLocationType)) {
            return 'Remote';
        }
    }
    
    return null;
}

/**
 * CRITICAL FIX #7: Better blocking detection
 */
function detectBlocking($, response, url) {
    const status = response?.statusCode;
    
    // Check status codes
    if ([403, 429, 503].includes(status)) {
        throw new Error(`Blocked with status ${status}`);
    }
    
    // Check for captcha/challenge pages
    const bodyText = $('body').text().toLowerCase();
    const title = $('title').text().toLowerCase();
    
    const blockIndicators = [
        'access denied',
        'captcha',
        'security check',
        'please verify',
        'are you a robot',
        'cloudflare',
        'just a moment',
    ];
    
    for (const indicator of blockIndicators) {
        if (bodyText.includes(indicator) || title.includes(indicator)) {
            throw new Error(`Blocked: Page contains "${indicator}"`);
        }
    }
    
    return true;
}

// ---------- Crawler Setup ----------
const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxConcurrency,
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 180,
    
    // CRITICAL: Session configuration for got-scraping
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 10,
            maxErrorScore: 3,
        },
    },
    
    preNavigationHooks: [
        async ({ request, session }) => {
            // Random delays to appear human
            const delay = jitter(1500, 3500);
            await sleep(delay);
            
            // Set realistic headers (got-scraping already handles most)
            const ua = randFrom(USER_AGENTS);
            const headers = {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0',
            };
            
            // Add cookies if provided
            if (cookies.length > 0) {
                headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
            
            request.headers = { ...request.headers, ...headers };
            
            log.info(`🌐 ${request.userData.label || 'REQUEST'}: ${request.url}`);
        },
    ],
    
    async requestHandler({ request, $, response, session, enqueueLinks, crawler }) {
        // Check for blocking
        try {
            detectBlocking($, response, request.loadedUrl);
        } catch (error) {
            log.error(`🚫 ${error.message} - URL: ${request.loadedUrl}`);
            if (session) {
                session.markBad();
            }
            throw error;
        }
        
        // === HANDLE LISTING PAGES ===
        if (request.userData.label === 'LIST') {
            log.info('📋 Processing listing page...');
            
            // Extract job URLs
            const jobUrls = extractJobUrls($, request.loadedUrl);
            log.info(`Found ${jobUrls.length} job URLs`);
            
            if (jobUrls.length === 0) {
                log.warning('⚠️ No job URLs found on listing page');
                if (debugMode) {
                    await Actor.setValue(`no-jobs-${Date.now()}.html`, $.html());
                }
            }
            
            // Enqueue job detail pages
            for (const url of jobUrls) {
                if (!processedUrls.has(url) && pushedCount < results_wanted) {
                    await crawler.addRequests([{
                        url,
                        userData: { label: 'DETAIL' },
                        uniqueKey: url,
                    }]);
                    processedUrls.add(url);
                }
            }
            
            // Find next page
            const $next = $('a[rel="next"], a.next, .pagination a:contains("Next")').first();
            if ($next.length && pushedCount < results_wanted) {
                const nextHref = $next.attr('href');
                if (nextHref) {
                    const nextUrl = new URL(nextHref, request.loadedUrl).href;
                    log.info(`➡️ Next page: ${nextUrl}`);
                    await crawler.addRequests([{
                        url: nextUrl,
                        userData: { label: 'LIST' },
                        uniqueKey: nextUrl,
                    }]);
                }
            }
            
            return;
        }
        
        // === HANDLE JOB DETAIL PAGES ===
        if (request.userData.label === 'DETAIL') {
            if (pushedCount >= results_wanted) {
                log.info(`✋ Reached target: ${pushedCount}/${results_wanted}`);
                return;
            }
            
            log.info('🔍 Extracting job details...');
            
            // Extract basic info
            const title = $('h1').first().text().trim();
            if (!title) {
                log.warning('⚠️ No title found - possibly blocked or wrong page');
                if (debugMode) {
                    await Actor.setValue(`no-title-${Date.now()}.html`, $.html());
                }
                return;
            }
            
            // Extract structured data
            const jsonLd = extractJsonLd($);
            const meta = extractJobMeta($);
            
            // Build job object
            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                company: extractCompany($, meta, jsonLd),
                location: extractLocation(meta, jsonLd),
                remote_level: meta.remote_level || null,
                job_type: meta.job_type || null,
                schedule: meta.schedule || (jsonLd?.employmentType ? 
                    String(jsonLd.employmentType).replace(/_/g, '-') : null),
                salary: meta.salary || (jsonLd?.baseSalary?.value?.value || 
                    jsonLd?.baseSalary?.value || null),
                benefits: meta.benefits || null,
                career_level: meta.career_level || null,
                ...extractDescription($, jsonLd),
                posted_date: jsonLd?.datePosted || null,
                valid_through: jsonLd?.validThrough || null,
                scraped_at: new Date().toISOString(),
            };
            
            // Validate job has minimum required data
            if (!job.company && !job.description?.text) {
                log.warning(`⚠️ Insufficient data for job: ${title}`);
                if (debugMode) {
                    await Actor.setValue(`insufficient-${Date.now()}.json`, job);
                }
                return;
            }
            
            log.info(`✅ [${pushedCount + 1}/${results_wanted}] ${job.title} @ ${job.company || 'Unknown'}`);
            
            await Actor.pushData(job);
            pushedCount++;
        }
    },
    
    failedRequestHandler({ request, error }) {
        log.error(`❌ Request failed: ${request.url}`);
        log.error(`Error: ${error.message}`);
        
        if (debugMode) {
            log.error(`Stack: ${error.stack}`);
        }
    },
});

// ---------- Start Crawling ----------
log.info('🚀 Starting FlexJobs scraper...');
log.info(`Configuration: ${maxConcurrency} concurrent, ${results_wanted} target`);

await crawler.run(
    startUrls.map(url => ({
        url,
        userData: { label: 'LIST' },
        uniqueKey: url,
    }))
);

log.info(`✅ Scraping complete! Scraped ${pushedCount} jobs`);
await Actor.exit();