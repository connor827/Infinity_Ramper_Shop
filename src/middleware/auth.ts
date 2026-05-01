import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(merchantId: string): string {
  return jwt.sign({ sub: merchantId }, env.JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string): { sub: string } | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'object' && decoded && 'sub' in decoded) {
      return { sub: String(decoded.sub) };
    }
    return null;
  } catch {
    return null;
  }
}
