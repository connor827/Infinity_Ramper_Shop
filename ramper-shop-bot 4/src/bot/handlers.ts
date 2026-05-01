import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from './factory.js';
import {
  upsertBuyer,
  listActiveProducts,
  getProduct,
  addToCart,
  getCart,
  clearCart,
  removeCartItem,
  setCartItemQuantity,
  createOrderFromCart,
  attachRamperToOrder,
  listCategoriesForMerchant,
} from '../db/shop.js';
import { ramperClient } from '../payments/ramper.js';
import { logger } from '../config/logger.js';
import type { ShippingAddress } from '../types/index.js';

export function registerHandlers(bot: Bot<BotContext>): void {
  // ----- Buyer identity middleware ---------------------------------------
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const buyer = await upsertBuyer(
      ctx.merchant.id,
      ctx.from.id,
      ctx.from.username ?? null,
      ctx.from.first_name ?? null
    );
    ctx.buyerId = buyer.id;
    await next();
  });

  // ----- /start -----------------------------------------------------------
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    const custom = ctx.merchant.welcome_message?.trim();
    const greeting = `Welcome to ${ctx.merchant.store_name}, ${name}.`;
    const body = custom && custom.length > 0
      ? `${greeting}\n\n${custom}`
      : `${greeting}\n\nTap a button to browse.`;
    await ctx.reply(body, {
      reply_markup: await mainMenu(ctx.buyerId, ctx.merchant.currency_code),
    });
  });

  // ----- /cart shortcut ---------------------------------------------------
  // Quick path to the cart from any state. Same renderer as menu:cart.
  bot.command('cart', async (ctx) => {
    await showCart(ctx);
  });

  // ----- Main menu --------------------------------------------------------
  bot.callbackQuery('menu:shop', async (ctx) => {
    await safeAnswer(ctx);
    await showCatalogue(ctx);
  });

  bot.callbackQuery('menu:cart', async (ctx) => {
    await safeAnswer(ctx);
    await showCart(ctx);
  });

  bot.callbackQuery('menu:help', async (ctx) => {
    await safeAnswer(ctx);
    const description = ctx.merchant.description?.trim();
    const helpBody =
      `\u2022 Browse products and add them to your cart\n` +
      `\u2022 Checkout via Infinity Ramper - pay with card, Apple Pay, Google Pay, bank transfer, or crypto\n` +
      `\u2022 You'll get a confirmation here once payment lands`;
    const text = description && description.length > 0
      ? `About ${ctx.merchant.store_name}\n\n${description}\n\n---\n\nHow it works\n\n${helpBody}`
      : `Help\n\n${helpBody}`;
    await safeEdit(ctx, text, new InlineKeyboard().text('back', 'menu:home'));
  });

  bot.callbackQuery('menu:home', async (ctx) => {
    await safeAnswer(ctx);
    await safeEdit(
      ctx,
      `Welcome to ${ctx.merchant.store_name}.`,
      await mainMenu(ctx.buyerId, ctx.merchant.currency_code)
    );
  });

  // Section headers in the catalogue are inline buttons with this callback.
  // We just acknowledge the tap so the loading spinner clears.
  bot.callbackQuery('noop', async (ctx) => {
    await safeAnswer(ctx);
  });

  // ----- Product view -----------------------------------------------------
  bot.callbackQuery(/^product:(.+)$/, async (ctx) => {
    const productId = ctx.match[1];
    await safeAnswer(ctx);
    const product = await getProduct(ctx.merchant.id, productId);
    if (!product) {
      await safeEdit(
        ctx,
        'That product is no longer available.',
        new InlineKeyboard().text('back', 'menu:shop')
      );
      return;
    }

    const caption =
      `${product.name}\n\n` +
      (product.description ? `${product.description}\n\n` : '') +
      `Price: ${formatMoney(product.price, product.currency_code)}\n` +
      `Stock: ${product.stock}`;

    const kb = new InlineKeyboard()
      .text('add to cart', `add:${product.id}:1`)
      .row()
      .text(await cartLabel(ctx.buyerId, ctx.merchant.currency_code), 'menu:cart')
      .row()
      .text('back', 'menu:shop');

    if (product.image_url) {
      try {
        await ctx.replyWithPhoto(product.image_url, { caption, reply_markup: kb });
        return;
      } catch {
        // fall through to text if image URL is unreachable
      }
    }
    await safeEdit(ctx, caption, kb);
  });

  // ----- Add to cart ------------------------------------------------------
  bot.callbackQuery(/^add:([a-f0-9-]+):(\d+)$/, async (ctx) => {
    const [, productId, qtyStr] = ctx.match;
    const qty = parseInt(qtyStr, 10);
    try {
      await addToCart(ctx.merchant.id, ctx.buyerId, productId, qty);
      await safeAnswer(ctx, 'Added to cart');
      // Refresh the keyboard so the running cart total updates without the
      // buyer having to navigate away. We only edit the reply markup, not
      // the photo or caption — that keeps the visible product card stable.
      const newKb = new InlineKeyboard()
        .text('add to cart', `add:${productId}:1`)
        .row()
        .text(await cartLabel(ctx.buyerId, ctx.merchant.currency_code), 'menu:cart')
        .row()
        .text('back', 'menu:shop');
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: newKb });
      } catch {
        // Editing can fail if the message is too old or the markup is
        // identical (Telegram returns 'message is not modified'). Either
        // way, swallow — the toast already confirmed the add.
      }
    } catch (err) {
      await safeAnswer(ctx, err instanceof Error ? err.message : 'Could not add', true);
    }
  });

  bot.callbackQuery(/^remove:([a-f0-9-]+)$/, async (ctx) => {
    await removeCartItem(ctx.buyerId, ctx.match[1]);
    await safeAnswer(ctx, 'Removed');
    await showCart(ctx);
  });

  // Increment / decrement quantity for a cart line. Encoded as
  //   qty:inc:<productId>:<currentQty>
  //   qty:dec:<productId>:<currentQty>
  // Embedding the current quantity in the callback data keeps this
  // stateless — we don't need to re-query the cart to know what
  // "next" should be. The DB function clamps stock and handles 0→remove.
  bot.callbackQuery(/^qty:(inc|dec):([a-f0-9-]+):(\d+)$/, async (ctx) => {
    const [, op, productId, currentStr] = ctx.match;
    const current = parseInt(currentStr, 10);
    const next = op === 'inc' ? current + 1 : current - 1;
    try {
      await setCartItemQuantity(ctx.buyerId, productId, next);
      await safeAnswer(ctx);
    } catch (err) {
      // Stock cap, or the line was already removed in another tab.
      // Show as an alert so the buyer actually sees it.
      await safeAnswer(ctx, err instanceof Error ? err.message : 'Could not update', true);
    }
    await showCart(ctx);
  });

  // ----- Checkout: collect shipping via session ---------------------------
  bot.callbackQuery('cart:checkout', async (ctx) => {
    await safeAnswer(ctx);
    ctx.session.checkout = { step: 'name', data: {} };
    await ctx.reply('Shipping details\n\nFull name?');
  });

  bot.callbackQuery('cart:clear', async (ctx) => {
    await clearCart(ctx.buyerId);
    await safeAnswer(ctx, 'Cart cleared');
    await showCart(ctx);
  });

  // ----- Text: drives the checkout flow -----------------------------------
  bot.on('message:text', async (ctx) => {
    const flow = ctx.session.checkout;
    if (!flow) return;

    const text = ctx.message.text.trim();

    switch (flow.step) {
      case 'name':
        flow.data.full_name = text;
        flow.step = 'email';
        await ctx.reply('Email address? (Ramper sends the receipt here)');
        return;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
          await ctx.reply('That doesn\'t look like an email. Try again?');
          return;
        }
        flow.data.email = text;
        flow.step = 'line_1';
        await ctx.reply('Street address?');
        return;
      case 'line_1':
        flow.data.line_1 = text;
        flow.step = 'city';
        await ctx.reply('City?');
        return;
      case 'city':
        flow.data.city = text;
        flow.step = 'postal_code';
        await ctx.reply('Postal code?');
        return;
      case 'postal_code':
        flow.data.postal_code = text;
        flow.step = 'country';
        await ctx.reply('Country?');
        return;
      case 'country':
        flow.data.country = text;
        flow.step = 'phone';
        await ctx.reply('Phone number? (or /skip)');
        return;
      case 'phone':
        if (text !== '/skip') flow.data.phone = text;
        flow.step = 'confirm';
        await ctx.reply(
          `Confirm delivery\n\n` +
            `${flow.data.full_name}\n` +
            `${flow.data.line_1}\n` +
            `${flow.data.city}, ${flow.data.postal_code}\n` +
            `${flow.data.country}\n` +
            (flow.data.phone ? `${flow.data.phone}\n` : '') +
            `\n${flow.data.email}`,
          {
            reply_markup: new InlineKeyboard()
              .text('confirm & pay', 'checkout:confirm')
              .row()
              .text('cancel', 'checkout:cancel'),
          }
        );
        return;
    }
  });

  bot.callbackQuery('checkout:cancel', async (ctx) => {
    ctx.session.checkout = undefined;
    await safeAnswer(ctx, 'Cancelled');
  });

  bot.callbackQuery('checkout:confirm', async (ctx) => {
    await safeAnswer(ctx);
    const flow = ctx.session.checkout;
    if (!flow || flow.step !== 'confirm') return;
    ctx.session.checkout = undefined;

    if (!ctx.merchant.payout_wallet) {
      await ctx.reply(
        'This store isn\'t ready to accept payments yet. Ask the merchant to finish setup.'
      );
      return;
    }

    try {
      const shipping: ShippingAddress = {
        full_name: flow.data.full_name!,
        line_1: flow.data.line_1!,
        city: flow.data.city!,
        postal_code: flow.data.postal_code!,
        country: flow.data.country!,
        phone: flow.data.phone,
        email: flow.data.email,
      };

      const order = await createOrderFromCart(
        ctx.merchant.id,
        ctx.buyerId,
        shipping,
        0,
        ctx.merchant.currency_code
      );

      const ramperWallet = await ramperClient.createWallet({
        merchantPayoutWallet: ctx.merchant.payout_wallet,
        orderId: order.id,
      });

      const paymentUrl = ramperClient.buildCheckoutUrl({
        addressIn: ramperWallet.address_in,
        amount: Number(order.total),
        currency: order.currency_code,
        email: flow.data.email!,
      });

      await attachRamperToOrder(order.id, {
        ramper_address_in: ramperWallet.address_in,
        ramper_polygon_addr: ramperWallet.polygon_address_in,
        payment_url: paymentUrl,
      });

      // Compose a confirmation message that gives the buyer everything they
      // need to (a) check we got their details right, (b) know what the
      // payment link does, (c) know what happens next.
      const addrSummary =
        `${shipping.full_name}\n` +
        `${shipping.line_1}${shipping.line_2 ? ', ' + shipping.line_2 : ''}\n` +
        `${shipping.city}, ${shipping.postal_code}\n` +
        `${shipping.country}`;

      await ctx.reply(
        `Order #${order.order_number} - ${ctx.merchant.store_name}\n\n` +
          `Items: ${formatMoney(String(order.subtotal), order.currency_code)}\n` +
          `Total: ${formatMoney(String(order.total), order.currency_code)}\n\n` +
          `Shipping to:\n${addrSummary}\n\n` +
          `Tap "Pay now" to complete checkout. Pay with card, Apple Pay, ` +
          `Google Pay, bank transfer, or crypto. You'll get a confirmation ` +
          `here once payment lands - usually within a minute.`,
        {
          reply_markup: new InlineKeyboard()
            .url('Pay now', paymentUrl)
            .row()
            .text('back to shop', 'menu:shop'),
        }
      );
    } catch (err) {
      logger.error({ err }, 'checkout failed');
      await ctx.reply(
        err instanceof Error ? `Checkout failed: ${err.message}` : 'Checkout failed'
      );
    }
  });
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

async function showCatalogue(ctx: BotContext): Promise<void> {
  const products = await listActiveProducts(ctx.merchant.id);
  if (products.length === 0) {
    await safeEdit(
      ctx,
      'No products available right now.',
      new InlineKeyboard().text('back', 'menu:home')
    );
    return;
  }

  // Pull the merchant's category list so we can render in the right order.
  // Categories are sorted by position then name in the DB layer; we just
  // build a lookup and bucket products into them.
  const categories = await listCategoriesForMerchant(ctx.merchant.id);

  // Bucket products: one bucket per category in order, plus an "uncategorised"
  // bucket at the end for products with category_id = null OR products whose
  // category was deleted (FK SET NULL takes care of that).
  type Bucket = { name: string; products: typeof products };
  const buckets: Bucket[] = categories.map((c) => ({ name: c.name, products: [] }));
  const buckByCatId = new Map<string, Bucket>();
  categories.forEach((c, i) => buckByCatId.set(c.id, buckets[i]));
  const uncategorised: Bucket = { name: 'Uncategorised', products: [] };

  for (const p of products) {
    const bucket = p.category_id ? buckByCatId.get(p.category_id) : undefined;
    if (bucket) {
      bucket.products.push(p);
    } else {
      uncategorised.products.push(p);
    }
  }

  // Only show the Uncategorised header if there are actually products in it.
  const finalBuckets = [...buckets.filter((b) => b.products.length > 0)];
  if (uncategorised.products.length > 0) finalBuckets.push(uncategorised);

  // Edge case: every category is empty AND every product has a deleted/missing
  // category — shouldn't happen, but if all buckets are empty, fall back to a
  // flat list so the buyer still sees something.
  if (finalBuckets.length === 0) {
    const kb = new InlineKeyboard();
    for (const p of products) {
      kb.text(`${p.name} — ${formatMoney(p.price, p.currency_code)}`, `product:${p.id}`).row();
    }
    kb.text(await cartLabel(ctx.buyerId, ctx.merchant.currency_code), 'menu:cart').row();
    kb.text('back', 'menu:home');
    await safeEdit(ctx, 'Shop', kb);
    return;
  }

  const kb = new InlineKeyboard();
  for (const bucket of finalBuckets) {
    // Section header — visually a button but tapping it does nothing.
    // We surround the name with em-dashes to make it look like a separator
    // rather than a tappable item.
    kb.text(`— ${bucket.name} —`, 'noop').row();
    for (const p of bucket.products) {
      kb.text(`${p.name} — ${formatMoney(p.price, p.currency_code)}`, `product:${p.id}`).row();
    }
  }
  kb.text(await cartLabel(ctx.buyerId, ctx.merchant.currency_code), 'menu:cart').row();
  kb.text('back', 'menu:home');

  await safeEdit(ctx, 'Shop', kb);
}

async function showCart(ctx: BotContext): Promise<void> {
  const items = await getCart(ctx.buyerId);
  if (items.length === 0) {
    // Empty cart — give them a one-tap path back to browsing rather than
    // dropping them at the welcome screen.
    await ctx.reply('Your cart is empty.', {
      reply_markup: new InlineKeyboard()
        .text('back to shop', 'menu:shop')
        .row()
        .text('home', 'menu:home'),
    });
    return;
  }

  const currency = ctx.merchant.currency_code;
  const lines = items.map(
    (i) =>
      `\u2022 ${i.product_name} x ${i.quantity} - ${formatMoney(
        String(Number(i.unit_price) * i.quantity),
        currency
      )}`
  );
  const total = items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0);

  // Build the keyboard. Each cart line gets its own row of controls so the
  // buyer can adjust quantity inline. Layout:
  //   [−]  [×N]  [+]  [remove]
  // The middle button shows the current quantity for visual balance and
  // taps as a no-op. The trailing 'remove' is a quick way to clear a single
  // line without dropping to 0 via the minus button.
  const kb = new InlineKeyboard();
  for (const i of items) {
    kb
      .text('−', `qty:dec:${i.product_id}:${i.quantity}`)
      .text(`×${i.quantity}`, 'noop')
      .text('+', `qty:inc:${i.product_id}:${i.quantity}`)
      .text('remove', `remove:${i.product_id}`)
      .row();
  }

  // Two main actions on top: checkout and keep shopping. Clear/home are
  // secondary, on the bottom row, less prominent.
  kb
    .text('checkout', 'cart:checkout')
    .text('keep shopping', 'menu:shop')
    .row()
    .text('clear', 'cart:clear')
    .text('home', 'menu:home');

  await ctx.reply(
    `Your cart\n\n${lines.join('\n')}\n\nTotal: ${formatMoney(String(total), currency)}`,
    { reply_markup: kb }
  );
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  return `${currency} ${n.toFixed(2)}`;
}

// Compute the label for the Cart button. Shows the running total when there
// are items, or '(empty)' when there aren't, so buyers always know what
// they've got without having to open the cart screen. Falls back to a plain
// 'Cart' label if the lookup throws — better than crashing the whole menu.
async function cartLabel(buyerId: string, currency: string): Promise<string> {
  try {
    const items = await getCart(buyerId);
    if (items.length === 0) return 'Cart (empty)';
    const total = items.reduce(
      (acc, it) => acc + Number(it.unit_price) * it.quantity,
      0
    );
    return `Cart (${formatMoney(String(total), currency)})`;
  } catch {
    return 'Cart';
  }
}

async function mainMenu(buyerId: string, currency: string): Promise<InlineKeyboard> {
  const cartTxt = await cartLabel(buyerId, currency);
  return new InlineKeyboard()
    .text('Shop', 'menu:shop')
    .text(cartTxt, 'menu:cart')
    .row()
    .text('Help', 'menu:help');
}

// ---------------------------------------------------------------------------
// Safe wrappers — never throw on stale callback queries or edits.
// These let the bot keep running even when individual Telegram calls fail.
// ---------------------------------------------------------------------------

async function safeAnswer(
  ctx: BotContext,
  text?: string,
  showAlert = false
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text, show_alert: showAlert } : undefined);
  } catch (err) {
    logger.warn({ err }, 'answerCallbackQuery failed (non-fatal)');
  }
}

async function safeEdit(
  ctx: BotContext,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(
      text,
      replyMarkup ? { reply_markup: replyMarkup } : undefined
    );
  } catch (err) {
    logger.warn({ err }, 'editMessageText failed, falling back to reply');
    try {
      await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    } catch (err2) {
      logger.error({ err: err2 }, 'reply fallback also failed');
    }
  }
}
