import { Resend } from "resend";
import { logger } from "./logger";
import { statusCopy } from "@workspace/order-statuses";

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

type EmailType = "invoice" | "tracking_update" | "password_reset";
type EmailContext = {
  businessId: string;
  businessName?: string | null;
  replyToEmail?: string | null;
};
type SendEmailRequest = EmailContext & {
  emailType: EmailType;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
};
type EmailResult = { success: boolean; messageId?: string; error?: string };

function senderName(name?: string | null): string {
  // Display names are tenant-controlled. Keep them out of header syntax.
  return name?.replace(/[\x00-\x1f\x7f"\\<>]/g, " ").trim() || "Logistics";
}

function validEmail(value: string): boolean {
  return /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/.test(value);
}

function getEmailSender(context: EmailContext): { from: string; replyTo: string } {
  const email = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!email || !validEmail(email)) {
    throw new Error("EMAIL_FROM_ADDRESS must be a single verified email address without a display name");
  }
  const replyTo = context.replyToEmail?.trim();
  return {
    from: `${senderName(context.businessName)} <${email}>`,
    replyTo: replyTo && validEmail(replyTo) ? replyTo : email,
  };
}

async function sendEmail(request: SendEmailRequest): Promise<EmailResult> {
  const { businessId, emailType, recipient } = request;
  const resend = getResend();
  if (!resend) {
    logger.error({ businessId, emailType, recipient }, "RESEND_API_KEY is not configured; email not sent");
    return { success: false, error: "Email provider not configured" };
  }
  let sender: ReturnType<typeof getEmailSender>;
  try {
    sender = getEmailSender(request);
  } catch (err) {
    logger.error({ businessId, emailType, recipient }, (err as Error).message);
    return { success: false, error: "Email sender not configured" };
  }
  try {
    const result = await resend.emails.send({
      ...sender,
      to: [recipient],
      subject: request.subject,
      text: request.text,
      html: request.html,
      ...(request.attachments ? { attachments: request.attachments } : {}),
    });
    if (result.error) {
      const error = result.error as { statusCode?: number; name?: string; message?: string };
      logger.error({
        businessId, emailType, recipient,
        resendStatusCode: error.statusCode,
        resendErrorName: error.name,
        resendErrorMessage: error.message,
      }, "Resend rejected email");
      return { success: false, error: error.message ?? "Failed to send email" };
    }
    return { success: true, messageId: result.data?.id };
  } catch (err) {
    const error = err as { statusCode?: number; name?: string; message?: string };
    logger.error({
      businessId, emailType, recipient,
      resendStatusCode: error.statusCode,
      resendErrorName: error.name,
      resendErrorMessage: error.message,
    }, "Resend email request failed");
    return { success: false, error: "Failed to send email" };
  }
}

export interface SendStatusEmailParams {
  businessId: string;
  customerEmail: string;
  customerName: string;
  trackingId: string;
  status: string;
  statusMessage: string | null;
  trackingLink: string;
  businessTrackingLink?: string | null;
  businessName: string;
  supportEmail: string;
  businessPhone?: string | null;
  businessAddress?: string | null;
  // Company-defined Job Number (e.g. CFS-0024), shown to the customer alongside
  // the tracking ID. Optional so older callers/tests still compile.
  jobNumber?: string | null;
  // Customer-facing shipment progress, oldest-first. Built from the Job's
  // tracking events (customer-visible statuses only - never internal notes).
  // Each label is a friendly status; `done` marks reached stages.
  timeline?: { label: string; done: boolean }[];
  // Admin-customizable copy (from Settings). All optional; sensible defaults
  // are applied below so an empty value never produces an empty email.
  //   emailGreeting    - opening line, `{name}` is replaced with customer name.
  //   emailSignature   - sign-off block, `{businessName}` is replaced.
  //   emailFooterNote  - single paragraph above the support email line.
  emailGreeting?: string | null;
  emailSignature?: string | null;
  emailFooterNote?: string | null;
}

// ─── Customization helpers ──────────────────────────────────────────────────
function renderGreeting(template: string | null | undefined, customerName: string): string {
  const t = (template ?? "").trim() || "Hi {name},";
  return t.replace(/\{name\}/gi, customerName);
}

function renderSignature(template: string | null | undefined, businessName: string): string {
  const t = (template ?? "").trim() || "- {businessName}";
  return t.replace(/\{businessName\}/gi, businessName);
}

function renderFooterNote(template: string | null | undefined): string {
  return (template ?? "").trim();
}

// Status copy is now sourced from @workspace/order-statuses so the admin
// preview and the actual outgoing email cannot drift.
const copyFor = statusCopy;

function isFinalCollectionStatus(status: string): boolean {
  return status === "DELIVERED_READY_FOR_COLLECTION" || status === "Delivered / Ready for Collection";
}

// Only allow safe URL schemes through to the email so a malicious
// `websiteUrl` (e.g. `javascript:`) can't end up as a clickable link in
// the customer's inbox. Returns the original URL if safe, otherwise "".
function safeTrackingLink(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Templates ───────────────────────────────────────────────────────────────
function buildSubject(p: SendStatusEmailParams): string {
  const c = copyFor(p.status);
  // Subject must work in inbox previews. Lead with the headline + tracking ID.
  return `${c.headline} - ${p.trackingId}`;
}

function buildText(p: SendStatusEmailParams): string {
  const c = copyFor(p.status);
  const greeting = renderGreeting(p.emailGreeting, p.customerName);
  const signature = renderSignature(p.emailSignature, p.businessName);
  const footerNote = renderFooterNote(p.emailFooterNote);

  const lines = [
    greeting,
    "",
    c.headline + ".",
    c.intro,
    "",
  ];
  if (p.jobNumber && p.jobNumber.trim()) {
    lines.push(`Job Number: ${p.jobNumber.trim()}`);
  }
  lines.push(`Status: ${p.status}`);
  if (p.statusMessage && p.statusMessage.trim()) {
    lines.push("", "Note from our team:", p.statusMessage.trim());
  }
  const safeLink = safeTrackingLink(p.trackingLink);
  if (safeLink) {
    lines.push("", "View full tracking:", safeLink);
  }
  const safeBusinessTrackingLink = safeTrackingLink(p.businessTrackingLink ?? "");
  if (safeBusinessTrackingLink) {
    lines.push("", `Or view this shipment on ${p.businessName}'s website:`, safeBusinessTrackingLink);
  }
  if (isFinalCollectionStatus(p.status)) {
    const contactDetails = [p.businessName, p.businessAddress, p.businessPhone, p.supportEmail]
      .map((value) => value?.trim())
      .filter((value): value is string => !!value);
    if (contactDetails.length > 0) {
      lines.push("", "Collection / Contact Details", ...contactDetails);
    }
    lines.push("", "Please contact us if you need any assistance with collection.");
  }
  if (footerNote) {
    lines.push("", footerNote);
  }
  if (p.supportEmail) {
    lines.push("", `Questions? Reply to this email or contact ${p.supportEmail}.`);
  }
  lines.push("", signature);
  return lines.join("\n");
}

function buildHtml(p: SendStatusEmailParams): string {
  const c = copyFor(p.status);
  // p.customerName is escaped inside renderGreeting() via safeGreeting below.
  const safeBusiness = escapeHtml(p.businessName);
  const safeStatus = escapeHtml(p.status);
  const safeMessage = p.statusMessage?.trim() ? escapeHtml(p.statusMessage.trim()) : "";
  const safeSupport = p.supportEmail ? escapeHtml(p.supportEmail) : "";
  const safePhone = p.businessPhone?.trim() ? escapeHtml(p.businessPhone.trim()) : "";
  const safeAddress = p.businessAddress?.trim() ? escapeHtml(p.businessAddress.trim()) : "";
  // Only http(s) URLs survive `safeTrackingLink`; anything else becomes "".
  const validLink = safeTrackingLink(p.trackingLink);
  const safeLink = validLink ? escapeHtml(validLink) : "";
  const validBusinessLink = safeTrackingLink(p.businessTrackingLink ?? "");
  const safeBusinessLink = validBusinessLink ? escapeHtml(validBusinessLink) : "";

  // Customizable copy - placeholders substituted before escaping so admins
  // can edit wording in Settings without writing HTML.
  const safeGreeting = escapeHtml(renderGreeting(p.emailGreeting, p.customerName));
  // Signature is multi-line: convert newlines to <br> AFTER escaping.
  const safeSignature = escapeHtml(renderSignature(p.emailSignature, p.businessName))
    .replace(/\n/g, "<br />");
  const safeFooterNote = renderFooterNote(p.emailFooterNote)
    ? escapeHtml(renderFooterNote(p.emailFooterNote)).replace(/\n/g, "<br />")
    : "";
  const safeJobNumber = p.jobNumber?.trim() ? escapeHtml(p.jobNumber.trim()) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(buildSubject(p))}</title>
</head>
<body style="margin:0;padding:32px 20px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:auto;border-collapse:collapse;">

    <!-- Business header -->
    <tr>
      <td style="padding-bottom:20px;border-bottom:1px solid #e5e7eb;">
        <strong style="font-size:15px;color:#1a1a1a;">${safeBusiness}</strong>
      </td>
    </tr>

    <!-- Status headline -->
    <tr>
      <td style="padding:26px 0 0;">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;font-weight:bold;">${safeStatus}</p>
        <h1 style="margin:0 0 14px;font-size:22px;font-weight:bold;color:#1a1a1a;line-height:1.3;">${escapeHtml(c.headline)}</h1>
        <p style="margin:0 0 8px;font-size:15px;">${safeGreeting}</p>
        <p style="margin:0;font-size:15px;color:#374151;">${escapeHtml(c.intro)}</p>
      </td>
    </tr>

    ${safeMessage ? `
    <!-- Admin note -->
    <tr>
      <td style="padding:22px 0 0;">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;font-weight:bold;">A note from our team</p>
        <p style="margin:0;font-size:14px;color:#374151;white-space:pre-wrap;">${safeMessage}</p>
      </td>
    </tr>` : ""}

    ${isFinalCollectionStatus(p.status) ? `
    <tr>
      <td style="padding:22px 0 0;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;font-weight:bold;">Collection / Contact Details</p>
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;">
          <strong>${safeBusiness}</strong>${safeAddress ? `<br />${safeAddress}` : ""}${safePhone ? `<br />${safePhone}` : ""}${safeSupport ? `<br /><a href="mailto:${safeSupport}" style="color:#1a1a1a;">${safeSupport}</a>` : ""}
        </p>
        <p style="margin:10px 0 0;font-size:14px;color:#374151;">Please contact us if you need any assistance with collection.</p>
      </td>
    </tr>` : ""}

    <!-- Identifiers + progress + CTA -->
    <tr>
      <td style="padding:26px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;"><tr><td style="padding-top:24px;">
        ${safeJobNumber ? `
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;font-weight:bold;">Job number</p>
        <p style="margin:0 0 18px;font-size:15px;font-weight:bold;color:#1a1a1a;">${safeJobNumber}</p>` : ""}
        ${safeLink ? `
        <p style="margin:0;"><a href="${safeLink}" style="display:inline-block;padding:11px 22px;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;">Track your shipment</a></p>
        <p style="margin:10px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">Or open: <a href="${safeLink}" style="color:#374151;">${safeLink}</a></p>` : ""}
        ${safeBusinessLink ? `<p style="margin:12px 0 0;font-size:13px;"><a href="${safeBusinessLink}" style="color:#374151;text-decoration:underline;">View tracking on ${safeBusiness}</a></p>` : ""}
        </td></tr></table>
      </td>
    </tr>

    <!-- Signature -->
    <tr>
      <td style="padding:24px 0 0;">
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">${safeSignature}</p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:22px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;"><tr><td style="padding-top:22px;">
        ${safeFooterNote ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${safeFooterNote}</p>` : ""}
        <p style="margin:0;font-size:13px;color:#6b7280;">Questions about your shipment? ${safeSupport
          ? `Reply to this email or contact <a href="mailto:${safeSupport}" style="color:#1a1a1a;">${safeSupport}</a>.`
          : `Just reply to this email and we&#39;ll be in touch.`}</p>
        </td></tr></table>
      </td>
    </tr>

  </table>
</body>
</html>`;
}

// Public API kept stable. `buildEmailBody` still returns `{ subject, body }`
// where `body` is the plain-text version we persist to email_notifications
// for audit history (HTML is sent over the wire but not stored).
export function buildEmailBody(params: SendStatusEmailParams): { subject: string; body: string } {
  return {
    subject: buildSubject(params),
    body: buildText(params),
  };
}

export interface SendPasswordResetEmailParams {
  businessId: string;
  businessName?: string | null;
  supportEmail?: string | null;
  to: string;
  name: string;
  resetLink: string;
  expiresInMinutes: number;
}

export async function sendPasswordResetEmail(
  p: SendPasswordResetEmailParams,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const safeLink = safeTrackingLink(p.resetLink);
  if (!safeLink) {
    return { success: false, error: "Invalid reset link" };
  }
  const businessName = senderName(p.businessName);
  const subject = `Reset your ${businessName} password`;
  const text = [
    `Hi ${p.name || "there"},`,
    "",
    `We received a request to reset your ${businessName} password.`,
    `This link expires in ${p.expiresInMinutes} minutes:`,
    safeLink,
    "",
    "If you didn't request this, you can safely ignore this email.",
    "",
    `- ${businessName}`,
  ].join("\n");
  const safeName = escapeHtml(p.name || "there");
  const safeUrl = escapeHtml(safeLink);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;line-height:1.5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;">Reset your password</h1>
<p style="margin:0 0 16px;font-size:15px;color:#27272a;">Hi ${safeName},</p>
  <p style="margin:0 0 16px;font-size:15px;color:#52525b;">We received a request to reset your ${escapeHtml(businessName)} password. Click the button below to choose a new one. This link expires in ${p.expiresInMinutes} minutes.</p>
<p style="margin:0 0 16px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">Reset password</a></p>
<p style="margin:0 0 16px;font-size:12px;color:#a1a1aa;word-break:break-all;">Or open: <a href="${safeUrl}" style="color:#52525b;text-decoration:underline;">${safeUrl}</a></p>
<p style="margin:24px 0 0;font-size:13px;color:#71717a;">If you didn't request this, you can safely ignore this email - your password won't change.</p>
</td></tr></table></td></tr></table></body></html>`;
  return sendEmail({
    businessId: p.businessId, businessName: p.businessName,
    replyToEmail: p.supportEmail, emailType: "password_reset",
    recipient: p.to, subject, text, html,
  });
}

export async function sendStatusEmail(params: SendStatusEmailParams): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
}> {
  return sendEmail({
    businessId: params.businessId, businessName: params.businessName,
    replyToEmail: params.supportEmail, emailType: "tracking_update",
    recipient: params.customerEmail, subject: buildSubject(params),
    text: buildText(params), html: buildHtml(params),
  });
}

export interface SendInvoiceEmailParams {
  businessId: string;
  senderBusinessName?: string | null;
  customerEmail: string; customerName: string; customerAddress?: string | null; customerPhone?: string | null;
  invoiceNumber: string; createdAt: Date; dueDate: Date; description: string;
  serviceDetails: string; quantity: number; subtotal: number; additionalCharges: number;
  total: number; currency: string; businessName: string; supportEmail: string;
  companyRegistration?: string; businessPhone?: string | null; businessAddress?: string | null;
  taxNumber?: string | null; logoUrl?: string | null; paymentDetails?: string | null;
  paymentTerms?: string | null; footerNote?: string | null; primaryColor?: string | null;
  orderReference?: string | null; jobNumber?: string | null; trackingId?: string | null; externalTrackingNumber?: string | null;
  origin?: string | null; destination?: string | null; transportMode?: string | null; weight?: string | null;
}

export async function sendInvoiceEmail(p: SendInvoiceEmailParams): Promise<{success:boolean;messageId?:string;error?:string}> {
  // Base64 data URLs are supported by the PDF generator, but embedding them
  // in email HTML can make Resend reject the message or be stripped by inbox
  // clients. Only remote HTTP(S) logos are safe in the email body; the branded
  // PDF attachment still receives p.logoUrl unchanged.
  const emailLogo=/^https?:\/\//i.test(p.logoUrl||"")?p.logoUrl||"":"";
  const logo=emailLogo?`<img src="${escapeHtml(emailLogo)}" alt="${escapeHtml(p.businessName)}" style="display:block;max-width:150px;max-height:52px;object-fit:contain">`:`<strong style="font-size:19px;color:#1a1a1a">${escapeHtml(p.businessName)}</strong>`;
  const emailHtml=`<!doctype html><html><body style="margin:0;background:#ffffff;padding:40px 24px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.65">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your PDF invoice is attached.</div>
<div style="max-width:620px;margin:0 auto">
  <div style="margin-bottom:38px">${logo}</div>
  <p style="margin:0 0 22px;font-size:16px">Hi ${escapeHtml(p.customerName)},</p>
  <p style="margin:0 0 18px;font-size:16px">Thank you for choosing ${escapeHtml(p.businessName)}.</p>
  <p style="margin:0 0 18px;font-size:16px">Please find your invoice attached to this email as a PDF. All invoice, shipment and payment information is included in the attached document.</p>
  <p style="margin:0 0 30px;font-size:16px">Once payment has been confirmed, we’ll continue with the next stage of your shipment and keep you updated.</p>
  <p style="margin:0 0 38px;font-size:16px">If you have any questions, simply reply to this email and our team will assist you.</p>
  <p style="margin:0;font-size:15px">Kind regards,<br><strong>${escapeHtml(p.businessName)}</strong>${p.businessPhone?`<br><span style="color:#6b7280">${escapeHtml(p.businessPhone)}</span>`:""}</p>
</div>
</body></html>`;
  const text=`Hi ${p.customerName},\n\nThank you for choosing ${p.businessName}.\n\nPlease find your invoice attached to this email as a PDF. All invoice, shipment and payment information is included in the attached document.\n\nOnce payment has been confirmed, we’ll continue with the next stage of your shipment and keep you updated.\n\nIf you have any questions, simply reply to this email and our team will assist you.\n\nKind regards,\n${p.businessName}`;
  try{
    const { buildInvoicePdf } = await import("./invoice-pdf");
    const pdf = await buildInvoicePdf(p);
    return sendEmail({
      businessId:p.businessId,businessName:p.senderBusinessName ?? p.businessName,
      replyToEmail:p.supportEmail,emailType:"invoice",recipient:p.customerEmail,
      // Preserve the invoice legal-name subject; only the From display name
      // uses the workspace's current business name.
      subject:`Your invoice from ${senderName(p.businessName)}`,
      html:emailHtml,text,attachments:[{filename:`${p.invoiceNumber}.pdf`,content:pdf}],
    });
  }catch(err){
    const error=err as {name?:string;message?:string};
    logger.error({businessId:p.businessId,emailType:"invoice",recipient:p.customerEmail,errorName:error.name,errorMessage:error.message},"Failed to generate invoice email");
    return {success:false,error:"Failed to send invoice email"};
  }
}
