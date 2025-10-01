# FlexJobs Scraper (HTTP + Cheerio)

This Apify actor scrapes job listings from FlexJobs using HTTP requests and Cheerio for parsing. It is designed to be fast and lightweight, avoiding headless browsers like Playwright or Puppeteer.

## Features

- Scrapes FlexJobs job search results.
- Extracts job title, company, location, date posted, and description.
- Uses `got-scraping` for robust HTTP requests.
- Handles pagination to collect multiple pages of results.
- Saves results to the Apify dataset.

## Input

The actor accepts the following input fields:

- `keyword`: The job title or keywords to search for.
- `location`: The geographic location to filter jobs by.
- `posted_date`: Filter jobs by when they were posted (e.g., "24h", "7d", "30d", "anytime").
- `results_wanted`: The maximum number of jobs to scrape.

## Output

The actor outputs a dataset of job listings with the following fields:

- `title`: The job title.
- `company`: The company name.
- `location`: The job location.
- `date_posted`: When the job was posted.
- `description_html`: The job description in HTML format.
- `description_text`: The job description in plain text.
- `url`: The URL of the job posting.