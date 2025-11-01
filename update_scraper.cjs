const fs = require('fs');
const path = 'src/main.js';
let content = fs.readFileSync(path, 'utf8');

function replaceSection(startMarker, endMarker, replacement) {
  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Start marker not found: ${startMarker}`);
  }
  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    throw new Error(`End marker not found: ${endMarker}`);
  }
  content = content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

const extractBlock = String.raw`/**
 * CRITICAL FIX #5: Better URL detection for job listings + preview extraction
 */
function extractJobUrls($, baseUrl) {
    const entries = new Map();
    const selectors = [
        'a[href*="/publicjobs/"]',
        'a[href*="/remote-jobs/"][href*="-job-"]',
        'a[href*="/job/"]',
        'a.job-link',
        'a[class*="job-title"]',
        '[data-job-url]',
    ];

    for (const selector of selectors) {
        $(selector).each((_, element) => {
            const $element = $(element);
            const href = $element.attr('href') || $element.attr('data-job-url');
            if (!href) return;

            let absolute;
            try {
                absolute = new URL(href, baseUrl).href;
            } catch (error) {
                return;
            }

            if (!isJobDetailUrl(absolute)) return;

            const preview = buildPreviewFromListing($, $element, baseUrl);
            if (entries.has(absolute)) {
                const existing = entries.get(absolute);
                existing.preview = mergePreviewData(existing.preview, preview);
            } else {
                entries.set(absolute, { url: absolute, preview });
            }
        });
    }

    return Array.from(entries.values());
}

function isJobDetailUrl(url) {
    return url.includes('flexjobs.com') && (
        url.includes('/publicjobs/') ||
        url.includes('/remote-jobs/') ||
        url.includes('-job-') ||
        url.includes('/job/')
    );
}

function buildPreviewFromListing($, $element, baseUrl) {
    const preview = {};
    const $card = findListingCard($element);

    const title = cleanText($card.find('[data-testid*="title"], h2, h3, .job-title').first().text()) || cleanText($element.text());
    if (title) preview.title = title;

    const companyAttr = $element.attr('data-company-name') || $element.attr('data-company');
    const company = cleanText($card.find('[data-company-name], .job-company, .company, .employer').first().text()) ||
        (companyAttr ? cleanText(companyAttr) : null);
    if (company) preview.company = company;

    const companyLink = $card.find('a[href*="/company/"], a[href*="/companies/"], a[href*="/company-profile/"]').first().attr('href');
    if (companyLink) {
        try {
            preview.company_url = new URL(companyLink, baseUrl).href;
        } catch (error) {
            preview.company_url = companyLink;
        }
    }

    const location = cleanText(
        $card.find('[data-location], .job-location, .location, .job-card-location').first().text()
    ) || cleanText($element.attr('data-location'));
    if (location) preview.location = location;

    const timeElement = $card.find('time[datetime]').first();
    const posted = timeElement.attr('datetime') ||
        cleanText(timeElement.text()) ||
        cleanText($card.find('.job-date, .posted, .listing-date').first().text());
    if (posted) preview.date_posted = posted;

    const descriptionElement = $card.find('.job-description, .description, .job-snippet, .job-summary, p').first();
    if (descriptionElement && descriptionElement.length) {
        const html = descriptionElement.html();
        if (html) preview.description_html = html.trim();
        const text = cleanText(descriptionElement.text());
        if (text) preview.description_text = text;
    }

    const dataJob = $card.attr('data-job-json') ||
        $card.attr('data-job') ||
        $element.attr('data-job-json') ||
        $element.attr('data-job');
    const parsedData = safeJsonParse(dataJob);
    if (parsedData && typeof parsedData === 'object') {
        preview.company = preview.company || cleanText(parsedData.companyName || parsedData.company || parsedData.employer);
        preview.location = preview.location || cleanText(parsedData.location || parsedData.cityState || parsedData.city);
        preview.date_posted = preview.date_posted || parsedData.postedDate || parsedData.datePosted;
        const parsedHtml = parsedData.descriptionHtml || parsedData.description_html || parsedData.description;
        if (parsedHtml && !preview.description_html) {
            preview.description_html = parsedHtml;
            preview.description_text = preview.description_text || stripHtml(parsedHtml);
        }
        if (!preview.description_text && parsedData.shortDescription) {
            preview.description_text = cleanText(parsedData.shortDescription);
        }
        if (parsedData.companyUrl && !preview.company_url) {
            preview.company_url = parsedData.companyUrl;
        }
    }

    return preview;
}

function findListingCard($element) {
    const selectors = [
        '[data-testid*="job"]',
        '[data-test*="job"]',
        '[data-card-type*="job"]',
        'article',
        'li',
        '.job-card',
        '.job',
        '.job-listing',
        '.search-result',
        '.search-result-item',
    ];

    for (const selector of selectors) {
        const $candidate = $element.closest(selector);
        if ($candidate && $candidate.length) {
            return $candidate.first();
        }
    }

    return $element.parent().length ? $element.parent() : $element;
}

function mergePreviewData(existing = {}, addition = {}) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(addition)) {
        if (!value) continue;
        if (!merged[key] || (typeof value === 'string' && value.length > String(merged[key]).length)) {
            merged[key] = value;
        }
    }
    return merged;
}

function cleanText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
}

function stripHtml(html) {
    if (!html) return null;
    const $doc = cheerio.load(`<div>${html}</div>`);
    return cleanText($doc.text());
}

function safeJsonParse(value) {
    if (!value) return null;
    if (typeof value !== 'string') {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return null;
        }
    }
    const trimmed = value.trim().replace(/;$/, '');
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        return null;
    }
}

function extractEmbeddedJobPosting($) {
    const candidates = [];

    $('script[type="application/json"]').each((_, element) => {
        const raw = $(element).html();
        const parsed = safeJsonParse(raw);
        if (parsed) candidates.push(parsed);
    });

    $('script:not([src])').each((_, element) => {
        const raw = $(element).html();
        if (!raw || raw.length < 80 || !/jobposting/i.test(raw)) return;

        const trimmed = raw.trim();
        const direct = safeJsonParse(trimmed);
        if (direct) {
            candidates.push(direct);
            return;
        }

        const nuxtMatch = trimmed.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
        if (nuxtMatch) {
            const parsed = safeJsonParse(nuxtMatch[1]);
            if (parsed) candidates.push(parsed);
        }

        const drupalMatch = trimmed.match(/Drupal\.settings\s*=\s*(\{[\s\S]*?\});/);
        if (drupalMatch) {
            const parsed = safeJsonParse(drupalMatch[1]);
            if (parsed) candidates.push(parsed);
        }

        const jsonMatches = trimmed.match(/\{[\s\S]*\}/g);
        if (jsonMatches) {
            for (const chunk of jsonMatches) {
                if (chunk.length > 8000) continue;
                const parsed = safeJsonParse(chunk);
                if (parsed) {
                    candidates.push(parsed);
                    break;
                }
            }
        }
    });

    for (const candidate of candidates) {
        const jobPosting = findJobPostingObject(candidate);
        if (jobPosting) return jobPosting;
    }

    return null;
}

function findJobPostingObject(input) {
    if (!input || typeof input !== 'object') return null;
    if (Array.isArray(input)) {
        for (const item of input) {
            const found = findJobPostingObject(item);
            if (found) return found;
        }
        return null;
    }

    if (input['@type'] === 'JobPosting' || input.type === 'JobPosting') {
        return input;
    }

    if (input.jobPosting) {
        const nested = findJobPostingObject(input.jobPosting);
        if (nested) return nested;
    }

    for (const value of Object.values(input)) {
        if (value && typeof value === 'object') {
            const found = findJobPostingObject(value);
            if (found) return found;
        }
    }

    return null;
}

function normalizeJobPosting(jobPosting) {
    if (!jobPosting || typeof jobPosting !== 'object') return null;

    const hiringOrg = jobPosting.hiringOrganization;
    const company = typeof hiringOrg === 'string'
        ? cleanText(hiringOrg)
        : cleanText(hiringOrg?.name || hiringOrg?.legalName || hiringOrg?.alternateName);

    const descriptionHtml = jobPosting.descriptionHtml || jobPosting.description || null;
    const descriptionText = descriptionHtml ? stripHtml(descriptionHtml) : cleanText(jobPosting.descriptionText || jobPosting.description);

    const location = normalizeJobLocation(jobPosting.jobLocation) ||
        (jobPosting.jobLocationType && /telecommute|remote/i.test(String(jobPosting.jobLocationType)) ? 'Remote' : null);

    let salary = null;
    if (jobPosting.baseSalary) {
        const base = jobPosting.baseSalary;
        if (typeof base === 'string') {
            salary = base;
        } else if (typeof base === 'object') {
            if (base.value && typeof base.value === 'object') {
                salary = base.value.value || base.value.minValue || base.value.maxValue;
            } else {
                salary = base.value || base.minValue || base.maxValue || null;
            }
        }
    }

    return {
        company,
        company_url: typeof hiringOrg === 'object' ? hiringOrg.sameAs || hiringOrg.url || null : null,
        description_html: descriptionHtml || null,
        description_text: descriptionText || null,
        date_posted: jobPosting.datePosted || jobPosting.datePublished || jobPosting.postedDate || null,
        valid_through: jobPosting.validThrough || jobPosting.expirationDate || null,
        location,
        salary,
        employmentType: jobPosting.employmentType || null,
    };
}

function normalizeJobLocation(jobLocation) {
    if (!jobLocation) return null;
    const items = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
    for (const item of items) {
        if (!item) continue;
        if (typeof item === 'string') {
            const text = cleanText(item);
            if (text) return text;
            continue;
        }
        if (item.address) {
            const addr = item.address;
            const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
            const text = cleanText(parts.join(', '));
            if (text) return text;
        }
        if (item.name) {
            const text = cleanText(item.name);
            if (text) return text;
        }
    }
    return null;
}

function resolveDateValue(...candidates) {
    for (const candidate of candidates) {
        const parsed = parseDateCandidate(candidate);
        if (parsed) return parsed;
    }
    return null;
}

function parseDateCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate === 'object') {
        return parseDateCandidate(candidate.date || candidate.value || candidate.text);
    }
    const text = cleanText(candidate);
    if (!text) return null;
    const isoMatch = text.match(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/);
    const base = isoMatch ? isoMatch[0] : text;
    const parsed = new Date(base);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
    }
    const fallback = new Date(text.replace(/\//g, '-'));
    if (!Number.isNaN(fallback.getTime())) {
        return fallback.toISOString();
    }
    return null;
}
`;

replaceSection('/**\r\n * CRITICAL FIX #5: Better URL detection for job listings', '/**\r\n * CRITICAL FIX #6: Location extraction from JSON-LD', extractBlock + '\r\n');

const locationBlock = String.raw`/**
 * CRITICAL FIX #6: Location extraction from JSON-LD
 */
function extractLocation(meta, jsonLd, fallbackLocation) {
    if (meta.location) return meta.location;

    const structured = jsonLd || {};
    const jobLocation = structured.jobLocation;

    const normalized = normalizeJobLocation(jobLocation);
    if (normalized) return normalized;

    if (structured.jobLocationType && /telecommute|remote/i.test(String(structured.jobLocationType))) {
        return 'Remote';
    }

    if (fallbackLocation) {
        return cleanText(fallbackLocation);
    }

    return null;
}
`;
replaceSection('/**\r\n * CRITICAL FIX #6: Location extraction from JSON-LD', '/**\r\n * CRITICAL FIX #7: Better blocking detection', locationBlock + '\r\n');

const requestHandlerBlock = String.raw`    async requestHandler({ request, $, response, session, crawler }) {
        if (hasJobLimit && stopRequested) {
            log.debug(`Skipping ${request.url} because job target already reached.`);
            return;
        }

        try {
            detectBlocking($, response, request.loadedUrl);
        } catch (error) {
            log.error(`?? ${error.message} - URL: ${request.loadedUrl}`);
            if (session) {
                session.retire();
            }
            throw error;
        }

        const pageContentLength = $.html().length;
        const readingDelay = Math.min(calculateReadingTime(pageContentLength), 2000);
        const label = request.userData.label || 'DETAIL';

        if (label === 'LIST') {
            if (hasJobLimit && pushedCount >= targetJobs) {
                if (!stopRequested) {
                    stopRequested = true;
                    log.info(`🎯 Target already reached (${pushedCount}/${targetLabel}). Skipping remaining listings.`);
                    if (crawler?.autoscaledPool) {
                        try {
                            await crawler.autoscaledPool.abort();
                        } catch (err) {
                            log.debug(`Unable to abort autoscaled pool: ${err.message}`);
                        }
                    }
                }
                return;
            }

            log.info('?? Processing listing page...');
            await sleep(jitter(250, 650));

            const jobEntries = extractJobUrls($, request.loadedUrl);
            log.info(`Found ${jobEntries.length} job URLs (queue ${queuedDetailUrls.size}/${detailQueueLimit})`);

            if (jobEntries.length === 0 && debugMode) {
                await Actor.setValue(`no-jobs-${Date.now()}.html`, $.html());
            }

            let enqueuedCount = 0;
            for (const entry of jobEntries) {
                const { url, preview } = entry;
                if (processedUrls.has(url) || queuedDetailUrls.has(url)) {
                    continue;
                }

                if (hasJobLimit && (pushedCount + queuedDetailUrls.size) >= detailQueueLimit) {
                    break;
                }

                refererMap.set(url, request.loadedUrl);

                await crawler.addRequests([{
                    url,
                    userData: { label: 'DETAIL', preview },
                    uniqueKey: url,
                }]);

                processedUrls.add(url);
                queuedDetailUrls.add(url);
                enqueuedCount++;

                await sleep(jitter(50, 150));

                if (hasJobLimit && (pushedCount + queuedDetailUrls.size) >= detailQueueLimit) {
                    break;
                }
            }

            log.info(`?? Enqueued ${enqueuedCount} jobs. In-flight: ${queuedDetailUrls.size}, Completed: ${pushedCount}`);

            const $next = $('a[rel="next"], a.next, .pagination a:contains("Next")').first();
            if ($next.length && (!hasJobLimit || (pushedCount + queuedDetailUrls.size) < detailQueueLimit)) {
                const nextHref = $next.attr('href');
                if (nextHref) {
                    const nextUrl = new URL(nextHref, request.loadedUrl).href;
                    log.info(`?? Next page: ${nextUrl}`);
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

        if (label === 'DETAIL') {
            const preview = request.userData.preview || {};
            const detailKey = request.loadedUrl || request.url;

            try {
                if (hasJobLimit && pushedCount >= targetJobs) {
                    stopRequested = true;
                    return;
                }

                log.info('?? Extracting job details...');
                await sleep(readingDelay);

                const jsonLdFromPage = extractJsonLd($);
                const embeddedJobPosting = extractEmbeddedJobPosting($);
                const structuredJob = jsonLdFromPage || embeddedJobPosting || null;
                const normalizedJob = normalizeJobPosting(embeddedJobPosting);
                const meta = extractJobMeta($);

                let title = cleanText($('h1').first().text());
                if (!title) {
                    title = cleanText(structuredJob?.title) ||
                        cleanText(preview.title) ||
                        cleanText($('meta[property="og:title"]').attr('content'));
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

                let descData = extractDescription($, structuredJob);
                if ((!descData.text || descData.text.length < 60) && normalizedJob?.description_text) {
                    descData = {
                        html: normalizedJob.description_html || (normalizedJob.description_text ? `<p>${normalizedJob.description_text}</p>` : null),
                        text: normalizedJob.description_text,
                    };
                }
                if ((!descData.text || descData.text.length < 60) && preview.description_text) {
                    descData = {
                        html: preview.description_html || `<p>${preview.description_text}</p>`,
                        text: preview.description_text,
                    };
                }

                const company = extractCompany($, meta, structuredJob, descData.text, [
                    normalizedJob?.company,
                    preview.company,
                ]);

                const location = extractLocation(meta, structuredJob, normalizedJob?.location || preview.location);
                const remoteLevel = meta.remote_level || (structuredJob?.jobLocationType && /telecommute|remote/i.test(String(structuredJob.jobLocationType)) ? 'Remote' : null);

                const datePosted = resolveDateValue(
                    normalizedJob?.date_posted,
                    structuredJob?.datePosted,
                    meta.date_posted,
                    preview.date_posted,
                );
                const validThrough = resolveDateValue(
                    normalizedJob?.valid_through,
                    structuredJob?.validThrough,
                    meta.valid_through,
                );

                const employmentTypeCandidate = normalizedJob?.employmentType || structuredJob?.employmentType;
                const employmentType = employmentTypeCandidate ? String(employmentTypeCandidate).replace(/_/g, '-') : null;
                const schedule = meta.schedule || employmentType;
                const jobType = meta.job_type || employmentType;

                const salary = meta.salary ||
                    normalizedJob?.salary ||
                    (structuredJob?.baseSalary?.value?.value ??
                        structuredJob?.baseSalary?.value ??
                        structuredJob?.baseSalary ??
                        null);

                const job = {
                    source: 'flexjobs',
                    url: request.loadedUrl,
                    title,
                    company,
                    company_url: preview.company_url || normalizedJob?.company_url || null,
                    location,
                    remote_level: remoteLevel,
                    job_type: jobType,
                    schedule,
                    salary,
                    benefits: meta.benefits || null,
                    career_level: meta.career_level || null,
                    description_html: descData.html,
                    description_text: descData.text,
                    date_posted: datePosted,
                    valid_through: validThrough,
                    scraped_at: new Date().toISOString(),
                };

                if (!job.description_text && debugMode) {
                    log.warning(`?? Missing description for ${title} - saving snapshot`);
                    await Actor.setValue(`missing-description-${Date.now()}.html`, $.html());
                }

                log.info(`? [${pushedCount + 1}/${targetLabel}] ${job.title} @ ${job.company || 'Unknown'}`);

                await Actor.pushData(job);
                pushedCount++;

                if (session) {
                    session.markGood();
                }

                if (hasJobLimit && pushedCount >= targetJobs && !stopRequested) {
                    stopRequested = true;
                    log.info(`🎯 Reached target: ${pushedCount}/${targetLabel}. Requesting crawler stop.`);
                    if (crawler?.autoscaledPool) {
                        try {
                            await crawler.autoscaledPool.abort();
                        } catch (err) {
                            log.debug(`Unable to abort autoscaled pool: ${err.message}`);
                        }
                    }
                }
            } finally {
                if (detailKey) queuedDetailUrls.delete(detailKey);
                queuedDetailUrls.delete(request.url);
            }

            return;
        }
    },
`;
replaceSection('    async requestHandler({ request, $, response, session, enqueueLinks, crawler }) {', '    failedRequestHandler:', requestHandlerBlock);

content = content.replace('log.info(`?? Configuration: ${maxConcurrency} concurrent requests, ${results_wanted} jobs target`);', 'log.info(`?? Configuration: ${normalizedMaxConcurrency} concurrent requests, target ${targetLabel}`);');
content = content.replace('log.info(`? [${pushedCount + 1}/${results_wanted}] ${job.title} @ ${job.company || 'Unknown'}`);', 'log.info(`? [${pushedCount + 1}/${targetLabel}] ${job.title} @ ${job.company || 'Unknown'}`);');
content = content.replace('log.info(`? Reached target: ${pushedCount}/${results_wanted}`);', 'log.info(`? Reached target: ${pushedCount}/${targetLabel}`);');

fs.writeFileSync(path, content);
