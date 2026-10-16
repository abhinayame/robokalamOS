import type PDFKit from 'pdfkit';

export interface CertView { title: string; recipient_name: string; body: string; signatory_name: string | null; signatory_title: string | null; code: string; issued_on: string; template: string; accent: string | null; revoked: boolean }
const hexOk = (c: string | null | undefined, d: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : d);
const T = (doc: PDFKit.PDFDocument, text: string, x: number, y: number, o: PDFKit.Mixins.TextOptions & { size?: number; font?: string; color?: string }) => { doc.fillColor(o.color ?? '#000').font(o.font ?? 'Helvetica').fontSize(o.size ?? 12).text(text, x, y, o); };

/**
 * Draws one certificate on a landscape A4 page (842 x 595). Five looks share the same facts, so the wording never depends on the template:
 * classic (double border), modern (color band), playful (confetti), minimal (hairlines, serif) and midnight (dark with gold).
 */
export function drawCertificate(doc: PDFKit.PDFDocument, c: CertView, org: { name: string; color: string; logo?: Buffer | null }, qr: Buffer, issuedLabel: string) {
  const W = doc.page.width, H = doc.page.height; const accent = hexOk(c.accent, org.color); const tpl = c.template;
  const dark = tpl === 'midnight'; const ink = dark ? '#f5f1e6' : '#12263f'; const soft = dark ? '#b9c2d3' : '#555'; const gold = '#d9b25e';
  const logoAt = (x: number, y: number, s: number) => { if (org.logo) { try { doc.image(org.logo, x, y, { fit: [s, s] }); } catch { /* skip an unreadable logo */ } } };
  let cx = 50, cw = W - 100, tx = 50; let align: 'center' | 'left' = 'center';
  if (tpl === 'classic') {
    doc.rect(24, 24, W - 48, H - 48).lineWidth(3).strokeColor(accent).stroke(); doc.rect(32, 32, W - 64, H - 64).lineWidth(0.8).stroke();
    logoAt(W / 2 - 32, 56, 64); T(doc, org.name, 50, org.logo ? 126 : 70, { width: cw, align: 'center', font: 'Helvetica-Bold', size: 14, color: accent });
  } else if (tpl === 'modern') {
    doc.rect(0, 0, 210, H).fill(accent); logoAt(45, 50, 110); T(doc, org.name, 30, org.logo ? 170 : 60, { width: 150, align: 'left', font: 'Helvetica-Bold', size: 15, color: '#ffffff' });
    doc.rect(210, 0, 10, H).fill(hexOk(null, '#f5a524')); cx = 260; cw = W - 260 - 50; tx = 260; align = 'left';
  } else if (tpl === 'playful') {
    doc.rect(0, 0, W, H).fill('#fffaf0'); const cols = [accent, '#f5a524', '#0e9aa7', '#e8579a', '#6c63ff'];
    for (let i = 0; i < 26; i++) { const x = (i * 83) % W, y = (i * 47) % 60; doc.circle(x + 20, y + 14, 5 + (i % 4) * 2).fill(cols[i % 5]!); doc.circle(W - x - 20, H - y - 14, 5 + (i % 3) * 3).fill(cols[(i + 2) % 5]!); }
    doc.roundedRect(34, 34, W - 68, H - 68, 28).lineWidth(5).strokeColor(accent).stroke(); logoAt(W / 2 - 28, 74, 56); T(doc, org.name, 50, org.logo ? 136 : 84, { width: cw, align: 'center', font: 'Helvetica-Bold', size: 15, color: accent });
  } else if (tpl === 'minimal') {
    doc.moveTo(60, 70).lineTo(W - 60, 70).lineWidth(0.6).strokeColor('#999').stroke(); doc.moveTo(60, H - 70).lineTo(W - 60, H - 70).stroke(); logoAt(60, 90, 40);
    T(doc, org.name.toUpperCase(), 0, 84, { width: W - 60, align: 'right', font: 'Helvetica', size: 10, color: '#777', characterSpacing: 3 } as any);
  } else {
    doc.rect(0, 0, W, H).fill('#0b1730'); doc.rect(22, 22, W - 44, H - 44).lineWidth(1.5).strokeColor(gold).stroke(); doc.rect(30, 30, W - 60, H - 60).lineWidth(0.5).stroke();
    logoAt(W / 2 - 30, 52, 60); T(doc, org.name, 50, org.logo ? 118 : 66, { width: cw, align: 'center', font: 'Helvetica-Bold', size: 14, color: gold });
  }
  const titleY = tpl === 'modern' ? 120 : tpl === 'minimal' ? 150 : 160; const titleColor = dark ? gold : tpl === 'minimal' ? '#222' : accent;
  T(doc, c.title, cx, titleY, { width: cw, align, font: tpl === 'minimal' ? 'Times-Roman' : 'Helvetica-Bold', size: tpl === 'minimal' ? 38 : 34, color: titleColor });
  T(doc, 'This is to certify that', cx, titleY + 66, { width: cw, align, size: 13, color: soft });
  T(doc, c.recipient_name, cx, titleY + 92, { width: cw, align, font: tpl === 'minimal' ? 'Times-Italic' : 'Helvetica-Bold', size: tpl === 'minimal' ? 36 : 30, color: ink });
  T(doc, c.body, cx + (align === 'center' ? 70 : 0), titleY + 146, { width: cw - (align === 'center' ? 140 : 0), align, size: 14, color: dark ? '#e6e9f2' : '#222' });
  const sigX = tpl === 'modern' ? 260 : 90;
  if (c.signatory_name) { doc.moveTo(sigX, H - 120).lineTo(sigX + 190, H - 120).lineWidth(0.8).strokeColor(dark ? gold : '#444').stroke(); T(doc, c.signatory_name, sigX, H - 112, { width: 190, align: 'center', font: 'Helvetica-Bold', size: 12, color: ink }); if (c.signatory_title) T(doc, c.signatory_title, sigX, H - 96, { width: 190, align: 'center', size: 10, color: soft }); }
  const qx = W - 150, qy = H - 150; if (dark) doc.rect(qx - 4, qy - 4, 88, 88).fill('#ffffff'); doc.image(qr, qx, qy, { width: 80 });
  T(doc, `Verify: ${c.code}`, qx - 20, H - 66, { width: 120, align: 'center', size: 8, color: soft }); T(doc, `Issued ${issuedLabel}`, qx - 20, H - 56, { width: 120, align: 'center', size: 8, color: soft });
  if (c.revoked) { doc.save().rotate(-20, { origin: [W / 2, H / 2] }).fillColor('#b00020').opacity(0.25).fontSize(90).font('Helvetica-Bold').text('REVOKED', 0, H / 2 - 50, { align: 'center', width: W }).restore(); }
}
