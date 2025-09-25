// api/src/auth.ts
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SECRET = process.env.JWT_SECRET || 'dev-secret';

export function signToken(userId: string) {
  return jwt.sign({ uid: userId }, SECRET, { expiresIn: '7d' });
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie('auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,   // true in production over https
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}


export function clearAuthCookie(res: Response) {
  res.clearCookie('auth', { httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
}

export async function readUserFromReq(req: Request) {
  const token = (req as any).cookies?.auth;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET) as any;
    return prisma.user.findUnique({ where: { id: payload.uid } }); // <-- requires generated client
  } catch {
    return null;
  }
}

export function requireAuth(
  handler: (req: Request & { user: any }, res: Response, next?: NextFunction) => any
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const u = await readUserFromReq(req);
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    (req as any).user = u;
    return handler(req as any, res, next);
  };
}
