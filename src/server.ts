import { createApp } from "./app.js";
import { CONFIG } from "./config/env.config.js";

const app = createApp();
const port = CONFIG.port;

const server = app.listen(port, () => {
  console.log(`\n======================================================`);
  console.log(`  J.T. Kent's Repertory RAG & Clinical Assistant API`);
  console.log(`======================================================`);
  console.log(`  🚀 Server listening on:  http://localhost:${port}`);
  console.log(`  📖 Swagger UI Docs:     http://localhost:${port}/api/docs`);
  console.log(`  🩺 Health Check:        http://localhost:${port}/api/health`);
  console.log(`  🔍 Search Endpoint:     POST http://localhost:${port}/api/search`);
  console.log(`  ❓ Clarify Endpoint:    POST http://localhost:${port}/api/clarify`);
  console.log(`  📊 Repertorize Matrix:  POST http://localhost:${port}/api/repertorize`);
  console.log(`======================================================\n`);
});

function handleShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
