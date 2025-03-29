import express from "express";
import puppeteer from "puppeteer";
import {logger} from "./logger.js";

let browser; // Global persistent browser instance

// Launch browser
async function launchBrowser() {
    logger.info("Launching Brave browser...");
    return await puppeteer.launch({
        // executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        executablePath: "/usr/bin/brave-browser",
        headless: "new",
        args : [
            // Brave specific
            "--enable-features=Brave",
            "--brave-adblock-p3a-enabled=false",

            // Anti-detection
            "--disable-blink-features=AutomationControlled",
            "--disable-features=TranslateUI",

            // Media handling
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",

            // Performance
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",

            // Security/sandbox (use cautiously)
            "--no-sandbox",
            "--disable-setuid-sandbox",

            // Additional helpful flags
            "--disable-notifications",
            "--disable-infobars"
        ],

    });
}

// Function to extract video details (download URL and headers) from a given video page URL
async function extractVideoDetails(videoUrl) {
    const page = await browser.newPage();

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36";
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    let videoDirectUrl = null;
    const capturedUrls = new Set();

    page.on("response", async (response) => {
        const url = response.url();
        if (url.includes(".mp4") && !capturedUrls.has(url)) {
            capturedUrls.add(url);
            videoDirectUrl = url;
            logger.info(`Found Video URL: ${videoDirectUrl}`);
        }
    });

    logger.info(`Opening video page: ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: "networkidle2" });

    const playResult = await page.evaluate(() => {
        const clickElement = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const event = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
            });
            element.dispatchEvent(event);
            return true;
        };

        const video = document.querySelector("video");
        const playButtons = document.querySelectorAll('[class*="play-button"], .ytp-play-button, .play, .jw-video');

        if (video) {
            clickElement(video);
            try { video.play(); } catch (e) {}
        }

        playButtons.forEach((btn) => clickElement(btn));

        return { videoSrc: video?.src || null };
    });

    if (playResult.videoSrc && !videoDirectUrl) {
        videoDirectUrl = playResult.videoSrc;
        logger.info(`Found video URL from video element: ${videoDirectUrl}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (!videoDirectUrl) {
        const extractionResult = await page.evaluate(() => {
            const video = document.querySelector("video");
            const sources = document.querySelectorAll("source");
            let videoUrl = video?.src || null;
            for (const source of sources) {
                if (source.src) {
                    videoUrl = source.src;
                    break;
                }
            }
            return { videoUrl };
        });

        if (extractionResult.videoUrl) {
            videoDirectUrl = extractionResult.videoUrl;
        }
    }

    if (!videoDirectUrl) {
        await page.close();
        throw new Error("Could not find video URL");
    }

    const cookies = await page.cookies();
    const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const referer = page.url();
    await page.close();

    return {
        userAgent,
        cookie: cookieString,
        referer,
        downloadUrl: videoDirectUrl,
    };
}

// Express server setup
const app = express();
app.use(express.json());

app.post("/getvideo", async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: "Missing videoUrl in request body" });
    }
    try {
        const details = await extractVideoDetails(videoUrl);
        res.json(details);
    } catch (error) {
        logger.error(`Extraction error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
launchBrowser()
    .then((launchedBrowser) => {
        browser = launchedBrowser;
        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}`);
        });
    })
    .catch((error) => {
        logger.error(`Failed to launch browser: ${error.message}`);
        process.exit(1);
    });
