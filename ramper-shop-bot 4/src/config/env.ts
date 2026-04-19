import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string(),

  JWT_SECRET: z.string().min(32),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),

  PLATFORM_NAME: z.string().default('Infinity Ramper Shops'),

  // Affiliate wallet earns a split on every Ramper transaction.
  // Leave unset in dev to use plain wallet.php (no platform fee).
  PLATFORM_AFFILIATE_WALLET: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  // Ramper's affiliate param name isn't publicly documented yet.
  // Common guesses: "affiliate", "affiliate_address", "partner", "ref".
  // Override if Ramper confirms a different name.
  PLATFORM_AFFILIATE_PARAM: z.string().default('affiliate'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
