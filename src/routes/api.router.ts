import { Router } from "express";
import { searchHandler } from "../controllers/search.controller.js";
import { clarifyHandler } from "../controllers/clarify.controller.js";
import { repertorizeHandler } from "../controllers/repertorize.controller.js";
import { healthHandler } from "../controllers/health.controller.js";

export const apiRouter = Router();

apiRouter.get("/health", healthHandler);
apiRouter.post("/search", searchHandler);
apiRouter.post("/clarify", clarifyHandler);
apiRouter.post("/repertorize", repertorizeHandler);
