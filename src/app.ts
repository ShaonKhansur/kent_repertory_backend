import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes/api.router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): express.Application {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Swagger Documentation
  let swaggerSpecPath = path.resolve(__dirname, "swagger", "swagger.json");
  if (!fs.existsSync(swaggerSpecPath)) {
    swaggerSpecPath = path.resolve(__dirname, "../src/swagger/swagger.json");
  }
  if (fs.existsSync(swaggerSpecPath)) {
    const swaggerDocument = JSON.parse(fs.readFileSync(swaggerSpecPath, "utf-8"));
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
    app.get("/api/docs/json", (_req: Request, res: Response) => {
      res.json(swaggerDocument);
    });
  }

  // API Routes
  app.use("/api", apiRouter);

  // Root welcome
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "J.T. Kent's Repertory RAG & Clinical Assistant API",
      version: "1.0.0",
      supabase_configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
      docs: "/api/docs",
      health: "/api/health",
      endpoints: {
        search: "POST /api/search",
        clarify: "POST /api/clarify",
        repertorize: "POST /api/repertorize",
      },
    });
  });

  // 404 Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
  });

  // Global Error Handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({
        error: "Malformed JSON payload.",
        details: err.message,
        tip: "Check for trailing commas or missing quotes in your JSON request body.",
      });
      return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error.", message: err.message });
  });

  return app;
}
