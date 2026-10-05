/** Escape text for HTML. Every value that comes from a person goes through this before it is placed in an e-mail. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#12263f');
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');

export interface MailParts { orgName: string; color?: string; title: string; paragraphs: string[]; button?: { label: string; url: string } | null; footer?: string | null }

/** A plain, readable e-mail (HTML and text) in the organization's name and color. */
export function renderEmail(p: MailParts): { html: string; text: string } {
  const c = safeColor(p.color ?? '#12263f');
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f9;font-family:Arial,Helvetica,sans-serif;color:#12263f"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${c};color:#ffffff;padding:16px 24px;font-size:16px;font-weight:bold">${esc(p.orgName)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 14px">${esc(p.title)}</h1>
${p.paragraphs.map((t) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${esc(t)}</p>`).join('\n')}
${p.button ? `<p style="margin:20px 0"><a href="${esc(safeUrl(p.button.url))}" style="background:${c};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold;display:inline-block">${esc(p.button.label)}</a></p><p style="font-size:12px;color:#6b7a90;margin:0 0 12px;word-break:break-all">If the button does not work, copy this address into your browser:<br>${esc(p.button.url)}</p>` : ''}
</td></tr>${p.footer ? `<tr><td style="padding:0 24px 20px;font-size:12px;color:#6b7a90">${esc(p.footer)}</td></tr>` : ''}</table></td></tr></table></body></html>`;
  const text = [p.orgName, '', p.title, '', ...p.paragraphs.flatMap((t) => [t, '']), ...(p.button ? [`${p.button.label}: ${p.button.url}`, ''] : []), ...(p.footer ? [p.footer] : [])].join('\n');
  return { html, text };
}
