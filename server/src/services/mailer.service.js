/**
 * Outbound email.
 *
 * ── WHY THIS IS NOT AN MCP TOOL ─────────────────────────────────────────────
 * Every rule in this project says user-supplied URLs go through the egress
 * guard. Nothing here takes a URL from a user: the endpoint is a fixed
 * provider address and the only user-controlled value is an email ADDRESS,
 * which is not a network target. This is the same category as
 * services/llm.js, a provider client, not a fetcher, which is why
 * tests/architecture.test.js guards agents, controllers and routes but not
 * services.
 *
 * ── THREE DRIVERS, AND CONSOLE IS THE DEFAULT ───────────────────────────────
 * An unconfigured server must still work end to end for a developer who just
 * cloned the repo, so with no provider configured the link is written to the
 * log and registration succeeds. What must NEVER happen is that link reaching
 * an API response in production: see verification.service.js, which decides
 * separately whether it is safe to return it.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const MAIL_DRIVER = {
  RESEND: 'resend',
  SMTP: 'smtp',
  CONSOLE: 'console',
};

/**
 * Which driver is actually usable, given what is configured.
 *
 * Named `resolve` rather than read from a single env var on purpose: naming a
 * driver whose credentials are missing is exactly how a provider chain ends up
 * silently running on the wrong provider. If it cannot send, it says so and
 * falls back to console rather than pretending.
 */
export function resolveDriver() {
  const wanted = env.MAIL_DRIVER ?? MAIL_DRIVER.RESEND;
  if (wanted === MAIL_DRIVER.RESEND && env.RESEND_API_KEY) return MAIL_DRIVER.RESEND;
  if (wanted === MAIL_DRIVER.SMTP && smtpConfigured()) return MAIL_DRIVER.SMTP;
  return MAIL_DRIVER.CONSOLE;
}

/**
 * SMTP can be configured two ways, and the simple one exists on purpose.
 *
 * GMAIL_USER + GMAIL_APP_PASSWORD is the path most people actually take, and it
 * sidesteps a nasty failure: Google displays an app password as four
 * space-separated groups ("abcd efgh ijkl mnop"), and pasting that into a URL
 * produces a malformed connection string with an authentication error that
 * says nothing about spaces. Discrete variables let the code strip them.
 *
 * SMTP_URL remains for any other provider.
 */
export const smtpConfigured = () =>
  Boolean(env.SMTP_URL || (env.GMAIL_USER && env.GMAIL_APP_PASSWORD));

/** Google shows app passwords in groups of four; nobody removes the spaces. */
const normaliseAppPassword = (pw) => String(pw ?? '').replace(/\s+/g, '');

export const isMailConfigured = () => resolveDriver() !== MAIL_DRIVER.CONSOLE;

/**
 * The From address.
 *
 * Gmail will not let you send as an address you do not own: it silently
 * rewrites the header, or rejects outright, so when sending through Gmail the
 * default From must be the Gmail account itself rather than Resend's shared
 * sender.
 */
function fromAddress() {
  if (env.MAIL_FROM) return env.MAIL_FROM;
  if (resolveDriver() === MAIL_DRIVER.SMTP && env.GMAIL_USER) {
    return `AGENTIQ <${env.GMAIL_USER}>`;
  }
  return 'AGENTIQ <onboarding@resend.dev>';
}

class MailError extends Error {
  constructor(message, code = 'MAIL_SEND_FAILED') {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.text();
  if (!res.ok) {
    // Include what the provider said. "Request failed" on its own has cost this
    // project a debugging session before.
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body).message ?? detail; } catch { /* keep raw */ }
    throw new MailError(`Resend rejected the message (${res.status}): ${detail}`);
  }
  let id = null;
  try { id = JSON.parse(body).id ?? null; } catch { /* not fatal */ }
  return { driver: MAIL_DRIVER.RESEND, id };
}

async function sendViaSmtp({ to, subject, html, text }) {
  // Imported lazily so the module is only loaded by deployments that use SMTP.
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new MailError(
      'MAIL_DRIVER=smtp needs the nodemailer package. Run '
      + '`npm i nodemailer --workspace server`, or use MAIL_DRIVER=resend.',
      'MAIL_DRIVER_UNAVAILABLE',
    );
  }

  const transport = env.SMTP_URL
    ? nodemailer.createTransport(env.SMTP_URL)
    : nodemailer.createTransport({
      host: env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(env.SMTP_PORT ?? 465),
      secure: Number(env.SMTP_PORT ?? 465) === 465,
      auth: {
        user: env.GMAIL_USER,
        // Google displays app passwords as four space-separated groups and
        // nobody removes the spaces before pasting.
        pass: normaliseAppPassword(env.GMAIL_APP_PASSWORD),
      },
    });

  try {
    const info = await transport.sendMail({ from: fromAddress(), to, subject, html, text });
    return { driver: MAIL_DRIVER.SMTP, id: info.messageId ?? null };
  } catch (err) {
    // Gmail's own message is terse: "535-5.7.8 Username and Password not
    // accepted", and the cause is nearly always one of two specific things.
    // Naming them beats leaving someone to search for the error code.
    if (/invalid login|535/i.test(err.message)) {
      throw new MailError(
        `SMTP authentication was rejected: ${err.message.split('\n')[0]}. `
        + 'Use a Google APP PASSWORD, not the account password, and app passwords '
        + 'only exist once 2-Step Verification is enabled on that account.',
        'MAIL_AUTH_REJECTED',
      );
    }
    throw new MailError(`SMTP send failed: ${err.message}`);
  } finally {
    transport.close?.();
  }
}

/**
 * Sends one message. NEVER throws: a failure to send must not turn a
 * successful registration into a 500, and the caller decides what to tell the
 * user. Returns { sent, driver, error } so the caller can be honest about it.
 */
export async function sendMail({ to, subject, html, text }) {
  const driver = resolveDriver();

  if (driver === MAIL_DRIVER.CONSOLE) {
    logger.warn(
      { to, subject },
      'No mail provider configured: message not sent. Set RESEND_API_KEY to send for real.',
    );
    // The body carries the link, and a developer needs it to continue.
    logger.info({ to, body: text }, 'mail (console driver)');
    return { sent: false, driver, error: null };
  }

  try {
    const result = driver === MAIL_DRIVER.RESEND
      ? await sendViaResend({ to, subject, html, text })
      : await sendViaSmtp({ to, subject, html, text });
    logger.info({ to, driver: result.driver, id: result.id }, 'mail sent');
    return { sent: true, driver: result.driver, error: null };
  } catch (err) {
    logger.error({ to, driver, err: err.message }, 'mail send failed');
    return { sent: false, driver, error: err.message };
  }
}

/** Minimal HTML escaping for values interpolated into the template. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The verification email.
 *
 * Plain, no images, no tracking pixel. The URL appears as text as well as a
 * link because a plain-text client shows only the text part, and a link the
 * reader cannot see is a link they will not trust.
 */
export function verificationEmail({ displayName, url, ttlHours }) {
  const safeName = esc(displayName);
  const safeUrl = esc(url);

  return {
    subject: 'Verify your email for AGENTIQ',
    text: [
      `Hello ${displayName},`,
      '',
      'Confirm your email address to finish setting up your AGENTIQ account:',
      '',
      url,
      '',
      `This link works once and expires in ${ttlHours} hours.`,
      'If you did not create this account you can ignore this message: no account will be verified.',
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1d21">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e7eb;border-radius:8px;padding:28px">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;color:#6b7280;text-transform:uppercase">AGENTIQ</p>
    <h1 style="margin:0 0 16px;font-size:20px">Verify your email</h1>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.6">Hello ${safeName},</p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6">Confirm your email address to finish setting up your account.</p>
    <p style="margin:0 0 20px">
      <a href="${safeUrl}" style="display:inline-block;background:#1e3a8a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Verify email</a>
    </p>
    <p style="margin:0 0 6px;font-size:12px;color:#6b7280">Or paste this into your browser:</p>
    <p style="margin:0 0 20px;font-size:12px;word-break:break-all"><a href="${safeUrl}" style="color:#1e3a8a">${safeUrl}</a></p>
    <hr style="border:0;border-top:1px solid #e4e7eb;margin:20px 0">
    <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6">
      This link works once and expires in ${ttlHours} hours.<br>
      If you did not create this account, ignore this message: nothing will be verified.
    </p>
  </div>
</body></html>`,
  };
}

export default sendMail;
