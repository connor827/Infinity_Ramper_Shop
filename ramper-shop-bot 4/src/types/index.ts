export interface Merchant {
  id: string;
  email: string | null;
  store_name: string;
  store_slug: string;
  bot_token: string | null;
  bot_username: string | null;
  bot_id: number | null;
  admin_telegram_id: number | null;
  payout_wallet: string | null;
  wallet_verified_at: Date | null;
  currency_code: string;  // e.g. "USD", "EUR", "GBP"
  currency_display: string;  // legacy free-text display (kept for back-compat)
  status: 'pending' | 'active' | 'suspended' | 'terminated';
  onboarding_step: 'signup' | 'bot' | 'wallet' | 'store' | 'products' | 'live';
  created_at: Date;
  updated_at: Date;
}

export interface Product {
  id: string;
  merchant_id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price: string;          // in merchant's currency
  currency_code: string;
  image_url: string | null;
  stock: number;
  weight_grams: number | null;
  status: 'active' | 'inactive' | 'out_of_stock';
  created_at: Date;
  updated_at: Date;
}

export interface Buyer {
  id: string;
  merchant_id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_seen_at: Date;
  created_at: Date;
}

export interface Order {
  id: string;
  merchant_id: string;
  buyer_id: string;
  order_number: number;
  subtotal: string;
  shipping: string;
  total: string;
  currency_code: string;
  shipping_address: ShippingAddress | null;
  status:
    | 'awaiting_payment'
    | 'paid'
    | 'processing'
    | 'shipped'
    | 'delivered'
    | 'cancelled'
    | 'refunded';
  ramper_address_in: string | null;
  ramper_polygon_addr: string | null;
  payment_url: string | null;
  value_coin_received: string | null;
  txid_in: string | null;
  txid_out: string | null;
  paid_at: Date | null;
  // Fulfilment tracking (migration 003)
  tracking_number: string | null;
  tracking_carrier: string | null;
  tracking_url: string | null;
  merchant_notes: string | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  refunded_at: Date | null;
  refund_amount: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShippingAddress {
  full_name: string;
  line_1: string;
  line_2?: string;
  city: string;
  postal_code: string;
  country: string;
  phone?: string;
  email?: string;  // needed for Ramper checkout
}

export interface CartItem {
  id: string;
  cart_id: string;
  product_id: string;
  quantity: number;
  unit_price: string;
  product_name?: string;
  product_image?: string;
  product_stock?: number;
}
