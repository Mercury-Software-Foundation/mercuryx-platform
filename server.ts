import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import morgan from "morgan";
import { expressMiddleware } from "@apollo/server/express4";
import cors from "cors";
import bodyParser from "body-parser";
import { WebSocketClient, WebSocketServer } from "websocket";
// Mercury Core setup - Metadata API
import MetaApi from "./server/metadata/index.ts";
import { metaEvents } from "./server/metadata/Events.ts";
import { meta } from "./app/routes/counter.tsx";
import { profile } from "node:console";
import { Platform } from "./server/metadata/platform.ts";
import { transformSync } from "@babel/core";
import presetReact from "@babel/preset-react";
import jwt from "jsonwebtoken";

let interval: number;
// Websocket setup
const wss = new WebSocketServer(9080);
wss.on("connection", function (ws: WebSocketClient) {
  // ws.on("message", function (message: string) {
  interval = setInterval(() => {
    ws.send(
      JSON.stringify({
        data: new Date().toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })
    );
  }, 1000);
  // });
});
wss.on("close", function () {
  clearInterval(interval);
});
// Short-circuit the type-checking of the built output.
const BUILD_PATH = "./build/server/index.js";
const DEVELOPMENT = Deno.env.get("NODE_ENV") === "development";
const PORT = Number.parseInt(Deno.env.get("PORT") || "3000");
const DB_URL = Deno.env.get("DB_URL");
const REDIS_URL = Deno.env.get("REDIS_URL");

const app = express();
// Platform API Server
// const platformServer = new PlatformApi({
//   db: "mongodb://localhost:27017/mercury",
// });
// Metadata API server
export const metaServer = new MetaApi({
  db: DB_URL,
  redisUrl: REDIS_URL,
});
await metaServer.start();

app.use(cors<cors.CorsRequest>({ origin: "*" }));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));


metaEvents.on("CREATE_MODEL_RECORD", async (data: any) => {
  await metaServer.restart();
  console.log("GraphQL Schema updated because:", data?.msg);
});

app.use(
  "/meta-api",
  cors<cors.CorsRequest>(),
  bodyParser.json(),
  expressMiddleware(metaServer.server, {
    context: async ({ req }) => {
      const JWT_SECRET = process.env.JWT_SECRET || "default-secret-key";
      const authHeader = req.headers.authorization || "";
      const profileHeader = req.headers.profile as string || "";
      let user = {
        id: null,
        profile: "Anonymous",
      };

      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        
        try {
          const decoded = jwt.verify(token, JWT_SECRET) as {
            id: any;
            profile: string;
          };
          user = {
            id: decoded.id,
            profile: decoded.profile || "Anonymous",
          };
        } catch (err) {
          console.warn("JWT verification failed:", err.message);
        }
      }
      if(profileHeader){
        user.profile = profileHeader;
      }
      
      return {
        ...req,
        user,
        platform: metaServer.platform,
      };
    },
  }) as unknown as express.RequestHandler
);

// app.use(
//   "/platform",
//   cors<cors.CorsRequest>(),
//   bodyParser.json(),
//   expressMiddleware(platformServer.server) as unknown as express.RequestHandler
// );

// React Router Setup
app.use(compression());
app.disable("x-powered-by");

if (DEVELOPMENT) {
  console.log("Starting development server");
  const viteDevServer = await import("vite").then((vite) =>
    vite.createServer({
      server: { middlewareMode: true },
    })
  );
  app.use(viteDevServer.middlewares);
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const source = await viteDevServer.ssrLoadModule("./server/app.ts");
      return await source.app(req, res, next);
    } catch (error) {
      if (typeof error === "object" && error instanceof Error) {
        viteDevServer.ssrFixStacktrace(error);
      }
      next(error);
    }
  });
} else {
  console.log("Starting production server");
  app.use(
    "/assets",
    express.static("build/client/assets", { immutable: true, maxAge: "1y" })
  );

  app.use(
    "/components",
    express.static("components", { immutable: true, maxAge: "1y" })
  );
  app.use(express.static("build/client", { maxAge: "1h" }));
  // app.use(
  //   "/server/assets",
  //   express.static("build/server/assets", { immutable: true, maxAge: "1y" })
  // );
  app.use(await import(BUILD_PATH).then((mod) => mod.app));
}

app.use(morgan("tiny"));

// await new Promise<void>((resolve) =>
//   httpServer.listen({ port: 4000 }, resolve)
// );
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
