// Operational email — admin notifications only.
//
// Historically this file drove email-linked signup + magic-link signin;
// both were removed when passkey-encrypted nsec storage shipped. We
// still need an email path for CSAM / abuse notifications to the
// operator's inbox (compliance), so the sender interface + Resend
// integration remain. Auth-code generation / user-facing messages are
// all gone.

import { Resend } from 'resend';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log('[email:dev]', JSON.stringify(message));
  }
}

class ResendEmailSender implements EmailSender {
  private resend: Resend;
  constructor(apiKey: string, private readonly from: string) {
    this.resend = new Resend(apiKey);
  }
  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    if (error) throw new Error(`Resend failed: ${error.message ?? 'unknown'}`);
  }
}

export function createEmailSender(): EmailSender {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? 'Deepmarks <noreply@deepmarks.org>';
  if (!key) {
    // The only emails routed through this sender are abuse / CSAM /
    // compliance notifications to the operator. Falling back to
    // stdout in production silently dumps that material into server
    // logs (and any log shipper downstream) — almost certainly NOT
    // what the operator wants. Warn loudly in non-dev so a misconfig
    // surfaces during deploy validation rather than after a real
    // incident.
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[email] CRITICAL: RESEND_API_KEY unset in production — abuse notifications will land in stdout instead of email. Set RESEND_API_KEY or wire a different EmailSender.',
      );
    } else {
      console.log('[email] RESEND_API_KEY not set — using console logger (dev mode)');
    }
    return new ConsoleEmailSender();
  }
  return new ResendEmailSender(key, from);
}
