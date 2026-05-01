import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const RAMPER_WALLET_API = 'https://api.infinityramper.com/control/wallet.php';
const RAMPER_AFFILIATE_API = 'https://api.infinityramper.com/control/affiliate.php';
const RAMPER_CHECKOUT = 'https://checkout.infinityramper.com/pay.php';
const RAMPER_CONVERT_API = 'https://api.infinityramper.com/control/convert.php';

export interface RamperWalletResponse {
  address_in: string;          // encrypted temp address — pass to checkout
  polygon_address_in: string;  // decrypted address — show to buyer as receiving address
  callback_url: string;        // echoed back from our request
  ipn_token: string;           // Ramper's IPN token — can be used for callback validation
}

export interface RamperCallbackParams {
  value_coin: string;
  coin: string;
  txid_in: string;
  txid_out: string;
}

/**
 * Reserve a temp receiving address for this order.
 *
 * If PLATFORM_AFFILIATE_WALLET is configured, we hit affiliate.php so Ramper
 * splits the payment on-chain between the merchant and the platform. No
 * fee inflation needed — the buyer pays the quoted price, Ramper handles
 * the split.
 *
 * If unset, we fall back to wallet.php (no platform fee). Useful for dev.
 *
 * The callback URL must include at least one unique GET parameter — we use
 * order_id. Reusing the same callback URL returns the same temp address,
 * so never reuse an order ID.
 */
export class RamperClient {
  async createWallet(params: {
    merchantPayoutWallet: string;
    orderId: string;
  }): Promise<RamperWalletResponse> {
    const callbackUrl = `${env.PUBLIC_URL}/webhook/ramper?order_id=${encodeURIComponent(params.orderId)}`;

    const useAffiliate = Boolean(env.PLATFORM_AFFILIATE_WALLET);
    const url = new URL(useAffiliate ? RAMPER_AFFILIATE_API : RAMPER_WALLET_API);
    url.searchParams.set('address', params.merchantPayoutWallet);
    url.searchParams.set('callback', callbackUrl);

    if (useAffiliate) {
      // Parameter name is configurable via env — Ramper's affiliate docs
      // aren't public yet, so keep this tweakable until we've confirmed.
      url.searchParams.set(env.PLATFORM_AFFILIATE_PARAM, env.PLATFORM_AFFILIATE_WALLET!);
    }

    logger.debug(
      { orderId: params.orderId, useAffiliate },
      'calling Ramper wallet API'
    );

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ramper wallet API failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as RamperWalletResponse;
    if (!data.address_in) {
      throw new Error('Ramper returned no address_in');
    }
    return data;
  }

  /**
   * Build the Smart Hosted checkout URL the buyer should visit.
   *
   * Note on URL encoding: Ramper's wallet/affiliate API returns `address_in`
   * as a base64-ish string containing reserved URL characters (+, /, =).
   * Depending on how the upstream API serialised it, it may already be
   * percent-encoded. We decode it once so that URLSearchParams.set — which
   * re-encodes — produces a correctly singly-encoded URL, not doubly-encoded.
   * A decodeURIComponent on a plain (not already encoded) string is a
   * no-op, so this is safe either way.
   */
  buildCheckoutUrl(params: {
    addressIn: string;
    amount: number;
    currency: string;
    email: string;
  }): string {
    const url = new URL(RAMPER_CHECKOUT);
    url.searchParams.set('address', safeDecode(params.addressIn));
    url.searchParams.set('amount', params.amount.toFixed(2));
    url.searchParams.set('currency', params.currency);
    url.searchParams.set('email', params.email);
    url.searchParams.set('domain', 'checkout.infinityramper.com');
    return url.toString();
  }

  /**
   * Convert an arbitrary currency amount to USD. Some Ramper providers
   * (Stripe, Robinhood, ramp.network) only support USD.
   */
  async convertToUsd(from: string, value: number): Promise<number> {
    if (from.toUpperCase() === 'USD') return value;

    const url = new URL(RAMPER_CONVERT_API);
    url.searchParams.set('from', from);
    url.searchParams.set('value', value.toFixed(2));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Ramper convert API failed: ${res.status}`);
    const data = (await res.json()) as { status: string; value_coin: string };
    if (data.status !== 'success') throw new Error('Ramper convert returned non-success');
    return Number(data.value_coin);
  }
}

export const ramperClient = new RamperClient();

/**
 * Percent-decode a string safely. If it's not encoded (or contains a stray
 * '%' not followed by two hex chars), return it unchanged rather than
 * throwing — which is what `decodeURIComponent` would do.
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
