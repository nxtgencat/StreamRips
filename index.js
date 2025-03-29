import express from "express";
import puppeteer from "puppeteer";
import {logger} from "./logger.js";
import os from "node:os";

let browser; // Global persistent browser instance
const requestQueue = []; // Queue to store pending requests
let isProcessing = false; // Flag to track if we're currently processing a request

// Launch browser
async function launchBrowser() {
    logger.info("Launching Brave browser...");

    const executablePath = os.platform() === "win32"
        ? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        : "/usr/bin/brave-browser";
    return await puppeteer.launch({
        executablePath: executablePath,
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

// Function to process the next request in the queue
async function processNextInQueue() {
    if (requestQueue.length === 0 || isProcessing) {
        return;
    }

    isProcessing = true;
    const { videoUrl, resolve, reject } = requestQueue.shift();

    logger.info(`Processing queued request for: ${videoUrl}`);

    try {
        const details = await extractVideoDetails(videoUrl);
        resolve(details);
    } catch (error) {
        logger.error(`Extraction error for ${videoUrl}: ${error.message}`);
        reject(error);
    } finally {
        isProcessing = false;
        // Process next request if any
        processNextInQueue();
    }
}

// Queue manager - adds request to queue and triggers processing if needed
function queueVideoExtractionRequest(videoUrl) {
    return new Promise((resolve, reject) => {
        // Add request to queue
        requestQueue.push({ videoUrl, resolve, reject });
        logger.info(`Request for ${videoUrl} added to queue. Queue length: ${requestQueue.length}`);

        // Trigger processing if not already processing
        if (!isProcessing) {
            processNextInQueue();
        }
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

    try {
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
            throw new Error("Could not find video URL");
        }

        const cookies = await page.cookies();
        const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        const referer = page.url();

        return {
            userAgent,
            cookie: cookieString,
            referer,
            downloadUrl: videoDirectUrl,
        };
    } catch (error) {
        throw error;
    } finally {
        // Always close the page to free resources
        await page.close();
    }
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
        // Queue the request instead of handling it immediately
        const details = await queueVideoExtractionRequest(videoUrl);
        res.json(details);
    } catch (error) {
        logger.error(`Request failed: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Add endpoint to get queue status
app.get("/status", (req, res) => {
    res.json({
        queueLength: requestQueue.length,
        isProcessing,
        currentlyProcessing: isProcessing ? requestQueue[0]?.videoUrl : null
    });
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