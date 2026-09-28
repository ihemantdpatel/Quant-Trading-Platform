/**
 * The outbound-mail port, and the only file that imports `nodemailer`.
 *
 * Same containment as `stoqey-ib-socket.ts`: everything above depends on
 * `Mailer`, so the report logic is tested against `RecordingMailer` without a
 * network, and SMTP's vocabulary stops here.
 */

import { createTransport } from 'nodemailer';
import { EmailConfig } from '../config/app-config.service';

export interface MailMessage {
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Nest token for the `Mailer`, or `null` when email is not configured. */
export const MAILER = Symbol('MAILER');

export class NodemailerMailer implements Mailer {
  private readonly transport: ReturnType<typeof createTransport>;

  constructor(private readonly config: EmailConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      // Bounded, for the reason every IB call is: a send that hangs must not
      // hold a timer callback (or an HTTP request) open indefinitely.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: this.config.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

/** Test double: records what would have been sent. */
export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failWith: Error | null = null;

  async send(message: MailMessage): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.sent.push(message);
  }
}
