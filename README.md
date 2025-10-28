# FlexJobs Scraper

High-performance job scraper for FlexJobs that extracts comprehensive job listings including company names, locations, salaries, and full descriptions. Built with advanced stealth capabilities to avoid blocking.

## Features

- 🚀 **Fast & Reliable** - Efficiently scrapes hundreds of jobs
- 🥷 **Stealth Mode** - Advanced anti-detection to prevent blocking
- 🎯 **Smart Extraction** - Captures company names even from restricted pages
- 📊 **Complete Data** - Gets titles, companies, locations, salaries, job types, and descriptions
- � **Auto Pagination** - Automatically crawls through multiple pages
- 💾 **Easy Export** - Data saved in JSON, CSV, or Excel formats

## How to Use

1. **Add Start URLs** - Provide FlexJobs category or search result URLs
2. **Set Job Limit** - Choose how many jobs to scrape (default: 100)
3. **Configure Proxy** - Select Apify Proxy (Residential recommended)
4. **Run** - Click start and get your data!

## Input Parameters

- **Start URLs** - FlexJobs URLs to begin crawling from
- **Maximum Jobs** - How many jobs to collect (default: 100)
- **Maximum Pages per Category** - Limit pagination to prevent long runs (default: 25)
- **Concurrency** - Number of simultaneous requests (2-3 = stealth, 5-10 = speed)
- **Proxy Configuration** - Required to avoid IP blocking
- **Cookies** - Optional authentication cookies

## Output Data

Each job listing includes:

- Job title
- Company name
- Location (city/state or "Remote")
- Remote work level (if applicable)
- Job type (Full-time, Part-time, Contract, etc.)
- Work schedule
- Salary range (when available)
- Benefits
- Experience level
- Full job description (HTML and plain text)
- Posted date
- Application deadline
- Job URL
- Scrape timestamp

## Best Practices

✅ **Use Residential Proxies** - Prevents blocking and 403 errors  
✅ **Start with Default Settings** - Optimized for balance of speed and stealth  
✅ **Use Category URLs** - Better than keyword search for comprehensive results  
✅ **Monitor Your Runs** - Check logs if you encounter issues  

## Example Start URLs

```
https://www.flexjobs.com/remote-jobs
https://www.flexjobs.com/remote-jobs/legitimate-work-from-home-jobs-hiring-now
https://www.flexjobs.com/jobs/software-development
https://www.flexjobs.com/jobs/customer-service
```

## Support

For issues or questions, please contact support or check the Apify documentation.

## Notes

- Scrapes public job listings only
- No login required
- Results may vary based on FlexJobs' site changes
- Proxy configuration strongly recommended