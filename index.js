import express from "express";
import puppeteer from "puppeteer";
import AdmZip from "adm-zip";
import {logger} from "./logger.js";
import path from "node:path";

const ZIP_FILE = path.resolve("./AdGuard.zip");
const EXTENSION_PATH = path.resolve("./AdGuard");


function extractZIP() {
    try {
        const zip = new AdmZip(ZIP_FILE);
        zip.extractAllTo(EXTENSION_PATH, true);
        console.log("Extension extracted successfully!");
    } catch (error) {
        console.error(`Error extracting ZIP: ${error.message}`);
    }
}

let browser; // Global persistent browser instance

// Launch browser with extension and wait until the extension is loaded
async function launchBrowserWithExtension() {
    await extractZIP();

    logger.info("Launching browser with extension...");
    const browser = await puppeteer.launch({
        headless: "new", // Running in headless mode
        executablePath: "/usr/bin/chromium-browser",
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            "--no-sandbox",
            "--disable-setuid-sandbox",
        ],
    });

    logger.info("Waiting for extension to load...");
    return new Promise(async (resolve) => {
        let timeoutId;
        const checkInterval = setInterval(async () => {
            const pages = await browser.pages();
            for (const page of pages) {
                const url = page.url();
                const title = await page.title();
                if (
                    title.includes("Thank you for installing AdGuard") ||
                    url.includes("welcome.adguard.com/v2/thankyou.html")
                ) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    logger.info("AdGuard extension fully loaded!");
                    resolve(browser);
                    return;
                }
            }
        }, 1000);

        timeoutId = setTimeout(() => {
            clearInterval(checkInterval);
            logger.info("Extension loading timeout reached, proceeding anyway");
            resolve(browser);
        }, 30000);
    });
}

// Function to extract video details (download URL and headers) from a given video page URL
async function extractVideoDetails(videoUrl) {
    const page = await browser.newPage();

    // Use a realistic user agent
    const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36";
    logger.info("Setting realistic user agent...");
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    let videoDirectUrl = null;
    const capturedUrls = new Set();

    // Listen to network responses to capture the video URL
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
    logger.info("Page loaded successfully");

    // Try to trigger video play by interacting with the page
    logger.info("Looking for video element...");
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
        const videoContainer = document.querySelector(
            ".video-container, .player-container, [id*='player']"
        );
        const playButtons = document.querySelectorAll(
            '[class*="play-button"], .ytp-play-button, .play, .jw-video'
        );

        let actions = [];

        if (video) {
            clickElement(video);
            try {
                video.play();
            } catch (e) {}
            actions.push("Video element clicked and play() called");
        }

        if (videoContainer) {
            clickElement(videoContainer);
            actions.push("Video container clicked");
        }

        if (playButtons.length > 0) {
            playButtons.forEach((btn) => clickElement(btn));
            actions.push(`${playButtons.length} play button(s) clicked`);
        }

        return {
            actions,
            videoSrc: video?.src || null,
        };
    });

    logger.info(`Video play attempts: ${playResult.actions}`);

    // If a source is available from the video element
    if (playResult.videoSrc && !videoDirectUrl) {
        videoDirectUrl = playResult.videoSrc;
        logger.info(`Found video URL from video element: ${videoDirectUrl}`);
    }

    logger.info("Waiting for video to load...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // If still no video URL, try extracting from the page content
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
            if (!videoUrl) {
                const scripts = document.querySelectorAll("script");
                for (const script of scripts) {
                    const content = script.textContent;
                    if (content) {
                        const match = content.match(/["'](https?:\/\/[^"']+\.mp4)["']/);
                        if (match) {
                            videoUrl = match[1];
                            break;
                        }
                    }
                }
            }
            return { videoUrl };
        });

        if (extractionResult.videoUrl) {
            videoDirectUrl = extractionResult.videoUrl;
            logger.info(`Found video URL from page content: ${videoDirectUrl}`);
        }
    }

    if (!videoDirectUrl) {
        await page.close();
        throw new Error("Could not find video URL");
    }

    logger.info("Extracting cookies...");
    const cookies = await page.cookies();
    const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    logger.info(`Found ${cookies.length} cookies`);

    const referer = page.url();

    await page.close();

    // Return all details as a single object
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

// Endpoint for the client to send a video URL and receive the headers and download URL
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

// Start the server after launching the browser
const PORT = process.env.PORT || 3000;
launchBrowserWithExtension()
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