import nodemailer from 'nodemailer';
import type { AccountRecord } from './types.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  sent: boolean;
  devCode?: string;
  error?: string;
}

export interface EmailProvider {
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<void>;
}

class GmailSmtpProvider implements EmailProvider {
  private getCredentials() {
    const user = (process.env.GMAIL_USER || '').trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || '').trim();
    return { user, pass };
  }

  isConfigured(): boolean {
    const { user, pass } = this.getCredentials();
    return Boolean(user && pass);
  }

  async send(message: EmailMessage): Promise<void> {
    const { user, pass } = this.getCredentials();
    if (!user || !pass) {
      throw new Error('Identifiants SMTP Gmail manquants.');
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 465,
      secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
      auth: { user, pass },
    });

    const from = (process.env.MAIL_FROM || `Gaius IA <${user}>`).trim();
    await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

function getEmailProvider(): EmailProvider {
  const providerName = (process.env.EMAIL_PROVIDER || 'smtp').trim().toLowerCase();
  switch (providerName) {
    case 'smtp':
    default:
      return new GmailSmtpProvider();
  }
}

const isProduction = () => process.env.NODE_ENV === 'production';

async function dispatchCodeEmail(
  email: string,
  code: string,
  message: EmailMessage,
): Promise<EmailSendResult> {
  const provider = getEmailProvider();
  if (!provider.isConfigured()) {
    if (!isProduction()) {
      console.info(`[Gaius IA · DEV EMAIL] Destinataire: ${email} | Code: ${code}`);
      return { sent: false, devCode: code };
    }
    return {
      sent: false,
      error: "L'envoi d'e-mails n'est pas encore configuré sur le serveur. Contactez l'administrateur.",
    };
  }

  try {
    await provider.send(message);
    return { sent: true };
  } catch (err) {
    console.error('Email send error:', err);
    if (!isProduction()) {
      console.info(`[Gaius IA · DEV EMAIL FALLBACK] Destinataire: ${email} | Code: ${code}`);
      return { sent: false, devCode: code };
    }
    return {
      sent: false,
      error: "Impossible d'envoyer l'e-mail pour le moment. Vérifiez l'adresse et réessayez.",
    };
  }
}

export async function sendVerificationCodeEmail(
  email: string,
  name: string,
  code: string,
): Promise<EmailSendResult> {
  const firstName = name.trim().split(/\s+/)[0] || 'utilisateur';
  return dispatchCodeEmail(email, code, {
    to: email,
    subject: `Votre code de vérification Gaius IA : ${code}`,
    text: [
      `Bonjour ${firstName},`,
      '',
      `Voici votre code de vérification pour activer votre compte Gaius IA : ${code}`,
      '',
      'Ce code est valable pendant 15 minutes.',
      "Si vous n'êtes pas à l'origine de cette demande, vous n'avez rien à faire et pouvez ignorer cet e-mail.",
      '',
      'Gaius IA',
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a;">
        <h2 style="margin:0 0 12px;font-size:20px;">Gaius IA</h2>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Bonjour ${escapeHtml(firstName)},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Voici votre code de vérification à 6 chiffres :</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;color:#0f172a;margin:0 0 16px;">
          ${escapeHtml(code)}
        </div>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;">Ce code est valable pendant <strong>15 minutes</strong>.</p>
        <p style="margin:0;font-size:13px;color:#64748b;">Si vous n'êtes pas à l'origine de cette demande, vous n'avez rien à faire et pouvez ignorer cet e-mail.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  code: string,
): Promise<EmailSendResult> {
  const firstName = name.trim().split(/\s+/)[0] || 'utilisateur';
  return dispatchCodeEmail(email, code, {
    to: email,
    subject: `Réinitialisation de votre mot de passe Gaius IA : ${code}`,
    text: [
      `Bonjour ${firstName},`,
      '',
      `Voici votre code pour réinitialiser votre mot de passe Gaius IA : ${code}`,
      '',
      'Ce code est valable pendant 15 minutes.',
      "Si vous n'êtes pas à l'origine de cette demande, vous n'avez rien à faire : votre mot de passe actuel reste inchangé.",
      '',
      'Gaius IA',
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a;">
        <h2 style="margin:0 0 12px;font-size:20px;">Gaius IA</h2>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Bonjour ${escapeHtml(firstName)},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Voici votre code de réinitialisation de mot de passe :</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;color:#0f172a;margin:0 0 16px;">
          ${escapeHtml(code)}
        </div>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;">Ce code est valable pendant <strong>15 minutes</strong>.</p>
        <p style="margin:0;font-size:13px;color:#64748b;">Si vous n'êtes pas à l'origine de cette demande, vous n'avez rien à faire : votre mot de passe actuel reste inchangé.</p>
      </div>
    `,
  });
}

export async function sendNewUserAdminNotification(user: AccountRecord): Promise<void> {
  const notifyTo = (process.env.ADMIN_NOTIFY_EMAIL || 'ndalagaius3@gmail.com').trim();
  if (!notifyTo) return;

  const provider = getEmailProvider();
  if (!provider.isConfigured()) {
    if (!isProduction()) {
      console.info(
        `[Gaius IA · DEV ADMIN NOTIFY] Nouvelle inscription : ${user.name} (${user.email}) via ${user.authProvider}`,
      );
    }
    return;
  }

  const dateStr = new Date(user.createdAt).toLocaleString('fr-FR', { timeZone: 'UTC' });
  try {
    await provider.send({
      to: notifyTo,
      subject: `Nouvelle inscription sur Gaius IA : ${user.name}`,
      text: [
        'Nouvelle inscription enregistrée sur Gaius IA :',
        `- Nom : ${user.name}`,
        `- E-mail : ${user.email}`,
        `- Mode de connexion : ${user.authProvider === 'google' ? 'Google' : 'E-mail'}`,
        `- Date (UTC) : ${dateStr}`,
        '',
        "Cet e-mail est automatique ; aucune action immédiate n'est requise de votre part.",
      ].join('\n'),
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a;">
          <h2 style="margin:0 0 12px;font-size:18px;">Nouvelle inscription sur Gaius IA</h2>
          <ul style="padding-left:18px;font-size:14px;line-height:1.6;">
            <li><strong>Nom :</strong> ${escapeHtml(user.name)}</li>
            <li><strong>E-mail :</strong> ${escapeHtml(user.email)}</li>
            <li><strong>Mode :</strong> ${user.authProvider === 'google' ? 'Google' : 'E-mail'}</li>
            <li><strong>Date (UTC) :</strong> ${escapeHtml(dateStr)}</li>
          </ul>
          <p style="margin-top:12px;font-size:12px;color:#64748b;">Notification automatique. Vous n'avez rien à faire si vous n'avez aucune action de gestion à effectuer.</p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('Admin new-user notification email failed:', err);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
