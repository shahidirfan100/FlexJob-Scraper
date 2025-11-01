import { Actor } from 'apify';
import { CheerioCrawler, log, sleep } from 'crawlee';
import * as cheerio from 'cheerio';

/**
 * FlexJobs Scraper - Enhanced Stealth Version
 * 
 * 🎓 STEALTH FEATURES IMPLEMENTED (Oct 2025):
 * ✅ Latest browser versions (Chrome 131)
 * ✅ Complete client hint headers (sec-ch-ua-*)
 * ✅ Version consistency (UA matches all headers)
 * ✅ Random timing patterns with network latency
 * ✅ Human-like delays (reading/browsing simulation)
 * ✅ Network latency simulation (DNS + TCP handshake)
 * ✅ Aggressive session rotation (max 8 uses per session)
 * ✅ Exponential backoff with jitter
 * ✅ Lower concurrency (default: 2 concurrent requests)
 * ✅ Natural request pacing between enqueues
 * ✅ Realistic referer chains tracked across navigation
 * ✅ No bot signatures (no DNT header, proper Sec-Fetch-*)
 * 
 * 🏢 COMPANY NAME EXTRACTION:
 * ✅ Multi-source extraction: JSON-LD, metadata, HTML selectors
 * ✅ Description text parsing (regex patterns)
 * ✅ Page metadata extraction (OpenGraph, Twitter)
 * ✅ Comprehensive fallback strategies
 * 
 * 🛡️ ANTI-BLOCKING:
 * ✅ 403 error detection and recovery
 * ✅ Session retirement on blocking
 * ✅ Exponential backoff (up to 60s)
 * ✅ Increased retry attempts (8 retries)
 * 
 * All existing selectors, pagination, and functionality preserved.
 * Compatible with Apify QA tests.
 */

// ---------- Configuration ----------
// 🎓 Oct 2025 Latest Browser Versions
const BROWSER_PROFILES = [
    {
        name: 'Chrome 131 Windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        platform: 'Windows',
        secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
        secChUaPlatform: '"Windows"',
        secChUaMobile: '?0',
        secChUaPlatformVersion: '"15.0.0"',
        secChUaFullVersionList: '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="131.0.6778.86"',
    },
    {
        name: 'Chrome 131 macOS',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        platform: 'macOS',
        secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
        secChUaPlatform: '"macOS"',
        secChUaMobile: '?0',
        secChUaPlatformVersion: '"14.6.0"',
        secChUaFullVersionList: '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="131.0.6778.86"',
    },
    {
        name: 'Chrome 130 Windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        platform: 'Windows',
        secChUa: '"Chromium";v="130", "Not_A Brand";v="24", "Google Chrome";v="130"',
        secChUaPlatform: '"Windows"',
        secChUaMobile: '?0',
        secChUaPlatformVersion: '"15.0.0"',
        secChUaFullVersionList: '"Chromium";v="130.0.6723.117", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="130.0.6723.117"',
    },
];

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs + 1)); }

// 🎓 Exponential backoff with jitter
function exponentialBackoff(retryCount) {
    const baseDelay = 2000;
    const maxDelay = 60000;
    const exponential = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    return exponential + jitter(0, 1000);
}

// 🎓 Human-like reading time based on content length
function calculateReadingTime(contentLength) {
    // Average reading speed: 200-250 words per minute
    // Assume ~5 chars per word
    const words = contentLength / 5;
    const baseDelayMs = Math.min(Math.max((words / 250) * 60 * 1000, 350), 1600);
    const variance = Math.max(Math.floor(baseDelayMs * 0.25), 120);
    const min = Math.max(200, baseDelayMs - variance);
    const max = baseDelayMs + variance;
    return jitter(Math.floor(min), Math.floor(max));
}

// ---------- Initialize ----------
await Actor.init();
const input = await Actor.getInput() || {};
const {
    results_wanted = 100,
    maxConcurrency = 2, // 🎓 Lower concurrency for stealth
    proxyConfiguration,
    startUrls = ['https://www.flexjobs.com/publicjobs'],
    cookies = [],
    debugMode = false,
} = input;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
let pushedCount = 0;
let processedUrls = new Set();
let refererMap = new Map(); // 🎓 Track referer chains
const detailQueueLimit = Math.max(results_wanted * 2, results_wanted + 20);

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
 * 🎓 Enhanced to extract from description, API endpoints, and multiple HTML sources
 */
function extractCompany($, meta, jsonLd, descriptionText) {
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
        '[data-employer]',
        '[itemprop="hiringOrganization"] [itemprop="name"]',
        '.company-name',
        '.job-company',
        '.employer-name',
        '[class*="company-name"]',
        '[class*="employer"]',
        'h2 a[href*="company"]',
        'span.company',
        'div.company',
    ];
    
    for (const selector of selectors) {
        const $el = $(selector).first();
        if ($el.length) {
            const text = $el.text().trim();
            if (text && text.length > 0 && text.length < 100) {
                candidates.push(text);
            }
            // Also try data attributes
            const dataCompany = $el.attr('data-company') || $el.attr('data-company-name');
            if (dataCompany) {
                candidates.push(dataCompany);
            }
        }
    }
    
    // 4. 🎓 NEW: Extract from description using patterns
    if (descriptionText) {
        // Pattern: "Company: XYZ" or "Employer: XYZ"
        const companyPattern = /(?:company|employer|organization|hiring):\s*([A-Z][A-Za-z0-9\s&,.-]{2,60})(?:\n|\.|\||$)/i;
        const match = descriptionText.match(companyPattern);
        if (match && match[1]) {
            candidates.push(match[1].trim());
        }
        
        // Pattern: "About [Company Name]" at start of description
        const aboutPattern = /^About\s+([A-Z][A-Za-z0-9\s&,.-]{2,60})(?:\n|:)/;
        const aboutMatch = descriptionText.match(aboutPattern);
        if (aboutMatch && aboutMatch[1]) {
            candidates.push(aboutMatch[1].trim());
        }
        
        // Pattern: "[Company Name] is hiring" or "Join [Company Name]"
        const hiringPattern = /(?:^|\n)([A-Z][A-Za-z0-9\s&,.-]{2,60})\s+(?:is hiring|is seeking|is looking for)/;
        const joinPattern = /(?:Join|Work at|Work for)\s+([A-Z][A-Za-z0-9\s&,.-]{2,60})(?:\n|\.|\||$)/;
        const hiringMatch = descriptionText.match(hiringPattern);
        const joinMatch = descriptionText.match(joinPattern);
        if (hiringMatch && hiringMatch[1]) {
            candidates.push(hiringMatch[1].trim());
        }
        if (joinMatch && joinMatch[1]) {
            candidates.push(joinMatch[1].trim());
        }
    }
    
    // 5. 🎓 NEW: Try to extract from page metadata
    const ogSiteName = $('meta[property="og:site_name"]').attr('content');
    const twitterSite = $('meta[name="twitter:site"]').attr('content');
    if (ogSiteName && ogSiteName.toLowerCase() !== 'flexjobs') {
        candidates.push(ogSiteName);
    }
    if (twitterSite && !twitterSite.startsWith('@')) {
        candidates.push(twitterSite);
    }
    
    // Clean and return first valid candidate
    for (const candidate of candidates) {
        const clean = candidate.replace(/\s+/g, ' ').trim();
        // Filter out non-company strings
        if (clean.length < 2 || clean.length > 100) continue;
        if (/^(flexjobs|apply|view|similar|jobs?|remote|work|hiring|the|a|an|and|or|position|role)$/i.test(clean)) continue;
        if (clean.toLowerCase().includes('flexjobs') && clean.toLowerCase().replace('flexjobs', '').trim().length === 0) continue;
        // Filter out dates and numbers only
        if (/^\d+$/.test(clean) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(clean)) continue;
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
        if (text.length > 40) {
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
        'section[data-test="job-description"]',
        'section[data-testid*="job-description"]',
        'div[data-test="job-description"]',
        'div[data-testid*="job-description"]',
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

        if (text.length > 40 && !text.toLowerCase().includes('similar jobs')) {
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

        if (text.length > 40) {
            return { html, text };
        }
    }

    const scriptDescription = extractDescriptionFromInlineScripts($);
    if (scriptDescription) {
        return scriptDescription;
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

function extractDescriptionFromInlineScripts($) {
    const scripts = $('script:not([src])').slice(0, 25);
    const patterns = [
        /"descriptionHtml"\s*:\s*"(.+?)"/is,
        /"jobDescriptionHtml"\s*:\s*"(.+?)"/is,
        /"jobDescription"\s*:\s*"(.+?)"/is,
        /"description"\s*:\s*"(.+?)"/is,
    ];

    for (const script of scripts) {
        const raw = $(script).html();
        if (!raw || raw.length < 60) continue;
        if (!/description/i.test(raw)) continue;

        for (const pattern of patterns) {
            const match = raw.match(pattern);
            if (!match) continue;

            const decoded = decodeEmbeddedJsonString(match[1]);
            if (!decoded) continue;

            const $wrapper = cheerio.load(`<div>${decoded}</div>`);
            const $container = $wrapper('div').first();
            const $cleaned = cleanDescriptionElement($container, $wrapper);
            const html = $cleaned.html();
            const text = $cleaned.text().replace(/\s+/g, ' ').trim();

            if (text.length > 40) {
                return { html, text };
            }
        }
    }

    return null;
}

function decodeEmbeddedJsonString(value) {
    if (!value) return null;

    let normalized = value
        .replace(/\\u003c/gi, '<')
        .replace(/\\u003e/gi, '>')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u0027/gi, "'")
        .replace(/\\u2019/gi, "'")
        .replace(/\\\//g, '/');

    try {
        const wrapped = `{"v":"${normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`;
        return JSON.parse(wrapped).v;
    } catch (error) {
        return normalized
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, ' ')
            .replace(/\\t/g, ' ');
    }
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
    maxConcurrency, // 🎓 Lower concurrency (default 2)
    maxRequestRetries: 8, // 🎓 Increased retries
    requestHandlerTimeoutSecs: 180,
    
    // 🎓 Aggressive session configuration
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: {
            maxUsageCount: 8, // 🎓 Rotate sessions more frequently
            maxErrorScore: 2, // 🎓 More strict error tolerance
        },
    },
    
    preNavigationHooks: [
        async ({ request, session }) => {
            // 🎓 Initialize session userData on first use
            if (session && !session.userData.browserProfile) {
                session.userData.requestCount = 0;
                session.userData.browserProfile = randFrom(BROWSER_PROFILES);
                session.userData.startTime = Date.now();
            }
            
            // ?? Network latency simulation (DNS + TCP handshake)
            const networkLatency = jitter(30, 120);
            await sleep(networkLatency);

            // ?? Human-like delays with variance
            const isDetailPage = request.userData.label === 'DETAIL';
            const baseDelay = isDetailPage ? jitter(450, 1100) : jitter(300, 800);
            await sleep(baseDelay);
            
            // Get browser profile from session
            const profile = session?.userData?.browserProfile || randFrom(BROWSER_PROFILES);
            
            // 🎓 Realistic referer chain
            let referer = refererMap.get(request.url) || 'https://www.google.com/';
            
            // 🎓 Complete client hint headers + version consistency
            const headers = {
                'User-Agent': profile.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Referer': referer,
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': referer.includes('flexjobs.com') ? 'same-origin' : 'cross-site',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
                // 🎓 Client Hints (Chrome 131)
                'sec-ch-ua': profile.secChUa,
                'sec-ch-ua-mobile': profile.secChUaMobile,
                'sec-ch-ua-platform': profile.secChUaPlatform,
                'sec-ch-ua-platform-version': profile.secChUaPlatformVersion,
                'sec-ch-ua-full-version-list': profile.secChUaFullVersionList,
                'sec-ch-ua-arch': '"x86"',
                'sec-ch-ua-bitness': '"64"',
                'sec-ch-ua-model': '""',
                // 🎓 NO DNT header (bots often set this)
            };
            
            // Add cookies if provided
            if (cookies.length > 0) {
                headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
            
            request.headers = { ...request.headers, ...headers };
            
            // Track session usage
            if (session) {
                session.userData.requestCount = (session.userData.requestCount || 0) + 1;
            }
            
            log.info(`🌐 ${request.userData.label || 'REQUEST'} [${profile.name}]: ${request.url}`);
        },
    ],
    
    async requestHandler({ request, $, response, session, enqueueLinks, crawler }) {
        // Check for blocking
        try {
            detectBlocking($, response, request.loadedUrl);
        } catch (error) {
            log.error(`🚫 ${error.message} - URL: ${request.loadedUrl}`);
            if (session) {
                session.retire();
            }
            throw error;
        }
        
        // 🎓 Simulate human reading time based on page content
        const pageContentLength = $.html().length;
        const readingDelay = Math.min(calculateReadingTime(pageContentLength), 2000); // Cap at 2s
        
        // === HANDLE LISTING PAGES ===
        if (request.userData.label === 'LIST') {
            log.info('📋 Processing listing page...');
            
            // 🎓 Simulate browsing time on listing
            await sleep(jitter(250, 650));
            
            // Extract job URLs
            const jobUrls = extractJobUrls($, request.loadedUrl);
            log.info(`Found ${jobUrls.length} job URLs`);
            
            if (jobUrls.length === 0) {
                log.warning('⚠️ No job URLs found on listing page');
                if (debugMode) {
                    await Actor.setValue(`no-jobs-${Date.now()}.html`, $.html());
                }
            }
            
            // Enqueue job detail pages with referer tracking
            let enqueuedCount = 0;
            for (const url of jobUrls) {
                if (processedUrls.has(url)) {
                    continue;
                }

                if (processedUrls.size >= detailQueueLimit || pushedCount >= results_wanted) {
                    break;
                }

                // ?? Track referer chain
                refererMap.set(url, request.loadedUrl);

                await crawler.addRequests([{
                    url,
                    userData: { label: 'DETAIL' },
                    uniqueKey: url,
                }]);
                processedUrls.add(url);
                enqueuedCount++;

                // ?? Natural pacing between enqueuing
                await sleep(jitter(50, 150));

                // Stop if we have enough jobs queued
                if (processedUrls.size >= detailQueueLimit) {
                    break;
                }
            }
            
            log.info(`📤 Enqueued ${enqueuedCount} jobs. Total queued: ${processedUrls.size}, Total scraped: ${pushedCount}`);
            
            // Find next page - only paginate if we need more jobs
            const $next = $('a[rel="next"], a.next, .pagination a:contains("Next")').first();
            if ($next.length && processedUrls.size < detailQueueLimit && pushedCount < results_wanted) {
                const nextHref = $next.attr('href');
                if (nextHref) {
                    const nextUrl = new URL(nextHref, request.loadedUrl).href;
                    log.info(`➡️ Next page: ${nextUrl}`);
                    
                    // 🎓 Track referer for pagination
                    refererMap.set(nextUrl, request.loadedUrl);
                    
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
            
            // 🎓 Simulate reading time before extraction
            await sleep(readingDelay);
            
            // Extract basic info
            let title = $('h1').first().text().trim();
            if (!title) {
                title = $('meta[property="og:title"]').attr('content')?.trim() || jsonLd?.title?.trim() || '';
            }

            if (!title) {
                const bodyText = $('body').text().toLowerCase();
                if (/log in|sign in|become a member|join flexjobs/.test(bodyText)) {
                    log.warning('?? Detail page requires authentication, skipping.');
                } else {
                    log.warning('?? No title found - possibly blocked or wrong page');
                    if (debugMode) {
                        await Actor.setValue(`no-title-${Date.now()}.html`, $.html());
                    }
                }
                return;
            }
            
            // Extract structured data
            const jsonLd = extractJsonLd($);
            const meta = extractJobMeta($);
            const descData = extractDescription($, jsonLd);
            
            // 🎓 Pass description to company extraction for fallback
            const company = extractCompany($, meta, jsonLd, descData.text);
            
            // Log extraction results
            if (debugMode) {
                log.debug(`📊 Extraction results for "${title}"`);
                log.debug(`   Company: ${company || 'NOT FOUND'}`);
                log.debug(`   Description: ${descData.text ? descData.text.substring(0, 100) + '...' : 'NOT FOUND'}`);
                log.debug(`   Date Posted: ${jsonLd?.datePosted || 'NOT FOUND'}`);
            }
            
            // Build job object
            const job = {
                source: 'flexjobs',
                url: request.loadedUrl,
                title,
                company,
                location: extractLocation(meta, jsonLd),
                remote_level: meta.remote_level || null,
                job_type: meta.job_type || null,
                schedule: meta.schedule || (jsonLd?.employmentType ? 
                    String(jsonLd.employmentType).replace(/_/g, '-') : null),
                salary: meta.salary || (jsonLd?.baseSalary?.value?.value || 
                    jsonLd?.baseSalary?.value || null),
                benefits: meta.benefits || null,
                career_level: meta.career_level || null,
                description_html: descData.html,
                description_text: descData.text,
                date_posted: jsonLd?.datePosted || null,
                valid_through: jsonLd?.validThrough || null,
                scraped_at: new Date().toISOString(),
            };
            
            // Validate job has minimum required data
            if (!job.title) {
                log.warning(`⚠️ Missing title for job`);
                if (debugMode) {
                    await Actor.setValue(`insufficient-${Date.now()}.json`, job);
                }
                return;
            }
            
            log.info(`✅ [${pushedCount + 1}/${results_wanted}] ${job.title} @ ${job.company || 'Unknown'}`);
            
            await Actor.pushData(job);
            pushedCount++;
            
            // 🎓 Mark session as good on success
            if (session) {
                session.markGood();
            }
        }
    },
    
    failedRequestHandler: async ({ request, error }, { session }) => {
        log.error(`❌ Request failed: ${request.url}`);
        log.error(`Error: ${error.message}`);
        
        // 🎓 Exponential backoff with jitter
        const retryCount = request.retryCount || 0;
        if (retryCount < 8) {
            const backoffDelay = exponentialBackoff(retryCount);
            log.info(`⏳ Backing off for ${backoffDelay}ms before retry ${retryCount + 1}`);
            await sleep(backoffDelay);
        }
        
        // 🎓 Retire session on repeated failures
        if (session && (error.message.includes('403') || error.message.includes('Blocked'))) {
            log.warning(`🔄 Retiring session due to blocking`);
            session.retire();
        }
        
        if (debugMode) {
            log.error(`Stack: ${error.stack}`);
        }
    },
});

// ---------- Start Crawling ----------
log.info('🚀 Starting FlexJobs scraper...');
log.info(`📊 Configuration: ${maxConcurrency} concurrent requests, ${results_wanted} jobs target`);
log.info(`🔗 Starting URLs: ${startUrls.join(', ')}`);

await crawler.run(
    startUrls.map(url => ({
        url,
        userData: { label: 'LIST' },
        uniqueKey: url,
    }))
);

log.info(`✅ Scraping complete! Successfully scraped ${pushedCount} jobs`);
log.info(`📈 Stats: ${processedUrls.size} URLs processed, ${pushedCount} jobs saved`);

await Actor.exit();
