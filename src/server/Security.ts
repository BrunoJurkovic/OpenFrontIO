// src/server/middleware/securityInterface.ts
import { Request, Response, NextFunction } from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

export enum LimiterType {
  Get = "get",
  Post = "post",
  Put = "put",
  WebSocket = "websocket",
}

export interface SecurityMiddleware {
  // The wrapper for request handlers with optional rate limiting
  httpHandler: (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
    limiterType: LimiterType,
  ) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

  // The wrapper for WebSocket message handlers with rate limiting
  wsHandler: (
    req: http.IncomingMessage | string,
    fn: (message: string) => Promise<void>,
  ) => (message: string) => Promise<void>;
}

// Function to get the appropriate security middleware implementation
async function getSecurityMiddleware(): Promise<SecurityMiddleware> {
  try {
    // Get the current file's directory
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    try {
      // Use dynamic import for ES modules - without file extension
      // ts-node will resolve this correctly
      const module = await import(
        "./security-middleware/RealSecurityMiddleware"
      );

      if (!module.RealSecurityMiddleware) {
        throw new Error("RealSecurityMiddleware class not found in module");
      }

      console.log("Successfully loaded real security middleware");
      return new module.RealSecurityMiddleware();
    } catch (error) {
      console.log("Failed to load real security middleware:", error);
      return new NoOpSecurityMiddleware();
    }
  } catch (e) {
    // Fall back to no-op if real implementation isn't available
    console.log("using no-op security middleware", e);
    return new NoOpSecurityMiddleware();
  }
}

export class NoOpSecurityMiddleware implements SecurityMiddleware {
  // Simple pass-through with no rate limiting
  httpHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
    limiterType: LimiterType,
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await fn(req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }

  // Corrected implementation for WebSocket handler wrapper
  wsHandler(
    req: http.IncomingMessage | string,
    fn: (message: string) => Promise<void>,
  ) {
    return async (message: string) => {
      try {
        await fn(message);
      } catch (error) {
        console.error("WebSocket handler error:", error);
      }
    };
  }
}

// Initialize the security middleware with a default implementation
// We'll use the NoOpSecurityMiddleware initially and then replace it
// with the real implementation once it's loaded
export const securityMiddleware: SecurityMiddleware =
  new NoOpSecurityMiddleware();

// Immediately try to load the real middleware
getSecurityMiddleware()
  .then((middleware) => {
    // Replace the methods of securityMiddleware with those from the loaded middleware
    Object.assign(securityMiddleware, middleware);
  })
  .catch((error) => {
    console.error("Failed to initialize security middleware:", error);
  });
