import { Hono } from "hono";
import { Env } from "./types";
import { OpenAIRoute } from "./routes/openai";
import { DebugRoute } from "./routes/debug";
import { openAIApiKeyAuth } from "./middlewares/auth";
import { loggingMiddleware } from "./middlewares/logging";

/**
 * Gemini CLI OpenAI Worker
 *
 * A Cloudflare Worker that provides OpenAI-compatible API endpoints
 * for Google's Gemini models via the Gemini CLI OAuth flow.
 *
 * Features:
 * - OpenAI-compatible chat completions and model listing
 * - OAuth2 authentication with token caching via Cloudflare KV
 * - Support for multiple Gemini models (2.5 Pro, 2.0 Flash, 1.5 Pro, etc.)
 * - Streaming responses compatible with OpenAI SDK
 * - Debug and testing endpoints for troubleshooting
 */

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// Add logging middleware
app.use("*", loggingMiddleware);

// Add CORS headers for all requests
app.use("*", async (c, next) => {
	// Set CORS headers
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

	// Handle preflight requests
	if (c.req.method === "OPTIONS") {
		c.status(204);
		return c.body(null);
	}

	await next();
});

// Apply OpenAI API key authentication middleware to all /v1 routes
app.use("/v1/*", openAIApiKeyAuth);

// Setup route handlers
app.route("/v1", OpenAIRoute);
app.route("/v1/debug", DebugRoute);

// Add individual debug routes to main app for backward compatibility
app.route("/v1", DebugRoute);

// Root endpoint - gooey animation page
app.get("/", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ai</title>
    <style>
@import url('https://fonts.googleapis.com/css?family=Exo+2');

* {
   margin: 0px;
   padding: 0px;
   box-sizing: content-box;
}

html, body {
   width: 100vw;
   height: 100vh;
   background: #0d0722;
}

body{
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #fff;
  font-family: 'Exo 2';
  font-size: 24px;
  animation: fadeIn 500ms reverse;
}

.gooey{
  background-image: linear-gradient(120deg, #34e0f0 0%, #b400ff 100%);
  border-radius: 42% 58% 70% 30% / 45% 45% 55% 55%;
  width: 150px; height: 144px;
  animation: morph 3s linear infinite;
  transform-style: preserve-3d;
  outline: 1px solid transparent;
  will-change: border-radius;
}
.gooey:before,
.gooey:after{
  content: '';
  width: 100%;
  height: 100%;
  display: block;
  position: absolute;
  left: 0; top: 0;
  border-radius: 42% 58% 70% 30% / 45% 45% 55% 55%;
  box-shadow: 5px 5px 89px rgba(0, 102, 255, 0.21);
  will-change: border-radius, transform, opacity;
  animation-delay: 200ms;
  background-image: linear-gradient(120deg, rgba(0,67,255,.55) 0%, rgba(0,103,255,.89) 100%);
}

.gooey:before{
  animation: morph 3s linear infinite;
  opacity: .21;
  animation-duration: 1.5s;
}

.gooey:after{
  animation: morph 3s linear infinite;
  animation-delay: 400ms;
  opacity: .89;
  content: "What's up?";
  line-height: 120px;
  text-indent: -21px;
}

@keyframes morph{
  0%,100%{
  border-radius: 42% 58% 70% 30% / 45% 45% 55% 55%;
    transform: translate3d(0,0,0) rotateZ(0.01deg);
  }
  34%{
      border-radius: 70% 30% 46% 54% / 30% 29% 71% 70%;
    transform:  translate3d(0,5px,0) rotateZ(0.01deg);
  }
  50%{
    opacity: .89;
    transform: translate3d(0,0,0) rotateZ(0.01deg);
  }
  67%{
    border-radius: 100% 60% 60% 100% / 100% 100% 60% 60% ;
    transform: translate3d(0,-3px,0) rotateZ(0.01deg);
  }
}

@keyframes fadeIn{
  100%{
    transform: scale(1.03);
    opacity: 0;
  }
}
    </style>
</head>
<body>
    <div class="gooey"></div>
</body>
</html>`;

	return c.html(html);
});

// Health check endpoint
app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;

