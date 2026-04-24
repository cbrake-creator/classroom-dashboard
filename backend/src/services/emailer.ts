// ──────────────────────────────────────────────────────────
//  Email dispatcher with a deliberately safe default.
//
//  If SMTP_HOST is unset, email "sends" are LOGGED and persisted to
//  data/email-outbox.jsonl — never actually transmitted. That keeps
//  the auto-recovery feature buildable + testable without risking
//  spamming helpdesk@dts.edu while we're still iterating.
//
//  When SMTP creds are filled in, switches to real SMTP via nodemailer.
// ──────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'emailer' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTBOX = resolve(__dirname, '..', '..', 'data', 'email-outbox.jsonl');
mkdirSync(dirname(OUTBOX), { recursive: true });

export interface EmailMessage {
  to: string | string[];
  subject: string;
  body: string;     // plain text
  html?: string;    // optional HTML
}

export async function send(msg: EmailMessage): Promise<{ delivered: boolean; mode: 'smtp' | 'log-only'; error?: string }> {
  const smtpConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
  const record = {
    ts: Date.now(),
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    from: config.smtp.from,
    subject: msg.subject,
    bodyPreview: msg.body.slice(0, 500),
    mode: smtpConfigured ? 'smtp' : 'log-only',
  };
  appendFileSync(OUTBOX, JSON.stringify(record) + '\n');

  if (!smtpConfigured) {
    log.info({ to: msg.to, subject: msg.subject }, 'email queued in log-only mode (SMTP not configured)');
    return { delivered: false, mode: 'log-only' };
  }

  // Real send via nodemailer when SMTP is set.
  try {
    const nodemailer = await import('nodemailer').catch(() => null);
    if (!nodemailer) {
      log.warn('nodemailer not installed — install `nodemailer` to enable real SMTP');
      return { delivered: false, mode: 'log-only', error: 'nodemailer not installed' };
    }
    const transporter = nodemailer.default.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
    await transporter.sendMail({
      from: config.smtp.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
      html: msg.html,
    });
    log.info({ to: msg.to, subject: msg.subject }, 'email sent');
    return { delivered: true, mode: 'smtp' };
  } catch (err) {
    const e = (err as Error).message;
    log.warn({ err: e }, 'email send failed');
    return { delivered: false, mode: 'smtp', error: e };
  }
}
