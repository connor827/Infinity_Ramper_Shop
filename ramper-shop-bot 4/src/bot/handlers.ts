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
  createOrderFromCart,
  attachRamperToOrder,
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
    await ctx.reply(body, { reply_markup: mainMenu() });
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
    await safeEdit(ctx, `Welcome to ${ctx.merchant.store_name}.`, mainMenu());
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
    } catch (err) {
      await safeAnswer(ctx, err instanceof Error ? err.message : 'Could not add', true);
    }
  });

  bot.callbackQuery(/^remove:([a-f0-9-]+)$/, async (ctx) => {
    await removeCartItem(ctx.buyerId, ctx.match[1]);
    await safeAnswer(ctx, 'Removed');
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

      await ctx.reply(
        `Order #${order.order_number} created\n\n` +
          `Total: ${formatMoney(String(order.total), order.currency_code)}\n\n` +
          `Tap below to pay. You'll get a confirmation here once payment lands.`,
        { reply_markup: new InlineKeyboard().url('Pay now', paymentUrl) }
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

  const kb = new InlineKeyboard();
  for (const p of products) {
    kb.text(`${p.name} - ${formatMoney(p.price, p.currency_code)}`, `product:${p.id}`).row();
  }
  kb.text('back', 'menu:home');

  await safeEdit(ctx, 'Shop', kb);
}

async function showCart(ctx: BotContext): Promise<void> {
  const items = await getCart(ctx.buyerId);
  if (items.length === 0) {
    await ctx.reply('Your cart is empty.', {
      reply_markup: new InlineKeyboard().text('back', 'menu:home'),
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

  const kb = new InlineKeyboard()
    .text('checkout', 'cart:checkout')
    .row()
    .text('clear', 'cart:clear')
    .text('back', 'menu:home');

  await ctx.reply(
    `Your cart\n\n${lines.join('\n')}\n\nTotal: ${formatMoney(String(total), currency)}`,
    { reply_markup: kb }
  );
}

function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Shop', 'menu:shop')
    .text('Cart', 'menu:cart')
    .row()
    .text('Help', 'menu:help');
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  return `${currency} ${n.toFixed(2)}`;
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
