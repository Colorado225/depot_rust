/**
 * LOT 10 — CORS strict pour le runtime desktop Tauri.
 *
 * Le preview web / la recette peuvent avoir une origine différente du serveur
 * (`tauri://localhost` / `http://tauri.localhost` vs `http://127.0.0.1:3000`).
 * Sans ces en-têtes, les 95 commandes de `COMMAND_HTTP_MAP` échoueraient sur un
 * contrôle CORS, malgré une CSP correcte.
 *
 * Seules les origines locales et l'hôte de preview Arena sont autorisées :
 * aucun service distant, conformité 100 % hors ligne. Le jeton reste porté par
 * l'en-tête Authorization : aucune cookie, aucun `Allow-Credentials`.
 */
import type { NextFunction, Request, Response } from 'express';

const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-DepotPro-Filename',
  'X-DepotPro-Source-Checksum',
] as const;

const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
  /^https?:\/\/tauri\.localhost(?::\d+)?$/,
  /^tauri:\/\/localhost$/,
  // Prévisualisation Arena (développement / recette), sans port dans l'origine.
  /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.e2b\.app$/,
];

/** Origine autorisée à joindre le backend local. Exportée pour les tests. */
export function isAllowedDesktopOrigin(origin: string, host?: string): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Même origine que le serveur (accès navigateur classique ou LAN).
  if (host && parsed.host === host) return true;
  if (!['http:', 'https:', 'tauri:'].includes(parsed.protocol)) return false;
  return LOCAL_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/** Middleware Express : à monter avant tous les routeurs `/api/*`. */
export function desktopCors() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    if (!isAllowedDesktopOrigin(origin, req.headers.host)) {
      res.status(403).json({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Origine non autorisée pour le backend local DepotPro CI.',
      });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(', '));
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      // Requêtes « private network » des webviews récentes (HTTPS → loopback).
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.status(204).end();
      return;
    }

    next();
  };
}
