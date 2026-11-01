import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { query, queryOne, type Db } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { fromPaise, rupees, toPaise } from './money.js';

/**
 * Receipt designs. Three looks: a formal bordered "classic" page, a "modern" page with a colour header and a big amount, and a narrow "slip"
 * for a till printer. The school picks one (and its own address, tax number, footer words and signature) and every receipt follows it; a
 * receipt that was corrected says so, and a cancelled one is stamped VOID. The ₹ sign needs a font that has it, so DejaVu ships with the app.
 */
export const RECEIPT_TEMPLATES = ['classic', 'modern', 'slip'] as const;
export type ReceiptTemplate = (typeof RECEIPT_TEMPLATES)[number];
const here = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.resolve(here, '../../../assets/fonts');
const FONT = { r: path.join(fontDir, 'DejaVuSans.ttf'), b: path.join(fontDir, 'DejaVuSans-Bold.ttf') };

// ---------------------------------------------------------------------------------------------- words
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const below100 = (n: number) => (n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
const below1000 = (n: number) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${below100(n % 100)}` : ''}` : below100(n));
/** 123456 → "one lakh twenty-three thousand four hundred fifty-six" (Indian grouping). */
export function numberInWords(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = []; let x = n;
  for (const [div, name] of [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand']] as const) { const q = Math.floor(x / div); if (q) { parts.push(`${below1000(q)} ${name}`); x -= q * div; } }
  if (x) parts.push(below1000(x));
  return parts.join(' ');
}
export function amountInWords(paise: number): string {
  const r = Math.floor(paise / 100); const p = paise % 100; const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `Rupees ${cap(numberInWords(r))}${p ? ` and ${numberInWords(p)} paise` : ''} only`;
}

// ---------------------------------------------------------------------------------------------- data
export interface ReceiptData {
  org: { name: string; address: string | null; taxId: string | null; header: string | null; footer: string | null; signatory: string | null; signatoryTitle: string | null; accent: string; logo: Buffer | null; template: ReceiptTemplate };
  pay: { receiptNo: string; paidAt: Date; createdAt: Date; method: string; reference: string | null; note: string | null; amount: number; refunded: number; status: string; revision: number; voidReason: string | null; credit: number };
  learner: { name: string; code: string; parent: string | null };
  lines: { title: string; label: string; amount: number }[];
  fees: { title: string; level: string | null; gross: number; discount: number; net: number; paidSoFar: number; balance: number }[];
}
const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

export async function loadReceiptData(orgId: string, paymentId: string, db?: Db): Promise<ReceiptData> {
  const pay = await queryOne(`SELECT p.*, l.full_name, l.learner_code FROM payments p JOIN learners l ON l.id = p.learner_id WHERE p.id = $1 AND p.org_id = $2`, [paymentId, orgId], db);
  if (!pay) throw notFound('Payment');
  const o = await queryOne(`SELECT name, brand_app_name, brand_color, brand_logo_file_id, receipt_template, receipt_address, receipt_tax_id, receipt_header, receipt_footer, receipt_signatory, receipt_signatory_title, receipt_accent, receipt_show_logo FROM organizations WHERE id = $1`, [orgId], db);
  let logo: Buffer | null = null;
  if (o?.receipt_show_logo && o.brand_logo_file_id) {
    const f = await queryOne(`SELECT data, mime_type FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [o.brand_logo_file_id, orgId], db);
    if (f && /^image\/(png|jpeg)$/.test(f.mime_type)) logo = f.data as Buffer;
  }
  const parent = await queryOne(`SELECT pa.full_name FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id = $1 ORDER BY lp.is_primary DESC, lp.created_at LIMIT 1`, [pay.learner_id], db);
  const lines = await query(`SELECT f.title, i.label, a.amount FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id JOIN learner_fees f ON f.id = i.learner_fee_id WHERE a.payment_id = $1 AND a.amount > 0 ORDER BY i.due_date, i.id`, [paymentId], db);
  const feeIds = (await query(`SELECT DISTINCT i.learner_fee_id AS id FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id WHERE a.payment_id = $1`, [paymentId], db)).map((r) => r.id as string);
  const fees: ReceiptData['fees'] = [];
  for (const id of feeIds) {
    const f = await queryOne(`SELECT title, level_label, gross_amount, discount_amount, net_amount FROM learner_fees WHERE id = $1`, [id], db); if (!f) continue;
    // what had been paid on this fee by the time of this payment (so an old receipt does not change when later instalments are paid)
    const paid = await queryOne(`SELECT COALESCE(SUM(a.amount), 0) AS n FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id JOIN payments p2 ON p2.id = a.payment_id
        WHERE i.learner_fee_id = $1 AND p2.status <> 'voided' AND (p2.paid_at < $2 OR (p2.paid_at = $2 AND p2.created_at <= $3))`, [id, pay.paid_at, pay.created_at], db);
    const net = toPaise(f.net_amount); const soFar = toPaise(paid!.n);
    fees.push({ title: f.title, level: f.level_label ?? null, gross: toPaise(f.gross_amount), discount: toPaise(f.discount_amount), net, paidSoFar: soFar, balance: Math.max(0, net - soFar) });
  }
  return {
    org: { name: o?.brand_app_name || o?.name || 'School', address: o?.receipt_address ?? null, taxId: o?.receipt_tax_id ?? null, header: o?.receipt_header ?? null, footer: o?.receipt_footer ?? null, signatory: o?.receipt_signatory ?? null, signatoryTitle: o?.receipt_signatory_title ?? null,
      accent: isHex(o?.receipt_accent) ? o.receipt_accent : isHex(o?.brand_color) ? o.brand_color : '#12263f', logo, template: (RECEIPT_TEMPLATES as readonly string[]).includes(o?.receipt_template) ? o.receipt_template : 'classic' },
    pay: { receiptNo: pay.receipt_no, paidAt: new Date(pay.paid_at), createdAt: new Date(pay.created_at), method: String(pay.method).replace('_', ' '), reference: pay.reference, note: pay.note, amount: toPaise(pay.amount), refunded: toPaise(pay.refunded_amount), status: pay.status, revision: Number(pay.revision), voidReason: pay.void_reason, credit: toPaise(pay.unallocated_amount) },
    learner: { name: pay.full_name, code: pay.learner_code, parent: parent?.full_name ?? null },
    lines: lines.map((l) => ({ title: l.title, label: l.label, amount: toPaise(l.amount) })), fees,
  };
}

/** Made-up data for the settings preview, so a school can see a design before any real payment exists. */
export function sampleReceipt(base: Pick<ReceiptData, 'org'>): ReceiptData {
  return { org: base.org, pay: { receiptNo: 'RK-RCT-000123', paidAt: new Date(), createdAt: new Date(), method: 'upi', reference: 'UPI 4021 7788 1290', note: null, amount: 200000, refunded: 0, status: 'captured', revision: 0, voidReason: null, credit: 0 },
    learner: { name: 'Aarav Kumar', code: 'RK-LRN-000042', parent: 'Meera Kumar' },
    lines: [{ title: 'Robotics Level 2', label: 'Installment 2 of 3', amount: 150000 }, { title: 'Robotics Level 2', label: 'Kit fee', amount: 50000 }],
    fees: [{ title: 'Robotics Level 2', level: 'Level 2', gross: 600000, discount: 60000, net: 540000, paidSoFar: 340000, balance: 200000 }] };
}

// ---------------------------------------------------------------------------------------------- drawing
const dateFmt = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function stamp(doc: PDFKit.PDFDocument, text: string, color: string) {
  doc.save(); doc.rotate(-28, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('B').fontSize(Math.min(70, doc.page.width / 5)).fillColor(color).opacity(0.16)
    .text(text, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false }); doc.restore(); doc.opacity(1);
}
function statusLine(d: ReceiptData) { return d.pay.status === 'voided' ? 'CANCELLED' : d.pay.revision > 0 ? `CORRECTED (revision ${d.pay.revision})` : null; }

/** Draw one receipt into `doc` (a fresh PDFDocument sized for the template). */
export function drawReceipt(doc: PDFKit.PDFDocument, d: ReceiptData) {
  doc.registerFont('R', FONT.r); doc.registerFont('B', FONT.b);
  if (d.org.template === 'modern') return modern(doc, d);
  if (d.org.template === 'slip') return slip(doc, d);
  return classic(doc, d);
}
export function newReceiptDoc(d: ReceiptData, title: string) {
  const size: [number, number] | string = d.org.template === 'slip' ? [226, 620] : 'A5';
  return new PDFDocument({ size: size as any, margin: d.org.template === 'slip' ? 14 : 34, info: { Title: title, Author: d.org.name } });
}
const totals = (d: ReceiptData) => ({ gross: d.fees.reduce((s, f) => s + f.gross, 0), discount: d.fees.reduce((s, f) => s + f.discount, 0), net: d.fees.reduce((s, f) => s + f.net, 0), paid: d.fees.reduce((s, f) => s + f.paidSoFar, 0), balance: d.fees.reduce((s, f) => s + f.balance, 0) });

function classic(doc: PDFKit.PDFDocument, d: ReceiptData) {
  const W = doc.page.width; const H = doc.page.height; const m = 34; const a = d.org.accent; const t = totals(d);
  doc.lineWidth(2).strokeColor(a).rect(18, 18, W - 36, H - 36).stroke(); doc.lineWidth(0.6).rect(23, 23, W - 46, H - 46).stroke();
  let y = 36;
  if (d.org.logo) { try { doc.image(d.org.logo, m, y, { fit: [46, 46] }); } catch { /* unreadable logo: skip it */ } }
  doc.font('B').fontSize(16).fillColor(a).text(d.org.name, m + 52, y + 2, { width: W - 2 * m - 104, align: 'center' });
  doc.font('R').fontSize(8).fillColor('#555');
  if (d.org.header) doc.text(d.org.header, m + 52, doc.y, { width: W - 2 * m - 104, align: 'center' });
  if (d.org.address) doc.text(d.org.address, m + 52, doc.y, { width: W - 2 * m - 104, align: 'center' });
  if (d.org.taxId) doc.text(`GSTIN / Reg. no: ${d.org.taxId}`, m + 52, doc.y, { width: W - 2 * m - 104, align: 'center' });
  y = Math.max(doc.y, y + 50) + 8; doc.moveTo(m, y).lineTo(W - m, y).lineWidth(0.8).strokeColor(a).stroke(); y += 8;
  doc.font('B').fontSize(12).fillColor('#111').text('FEE RECEIPT', m, y, { width: W - 2 * m, align: 'center', characterSpacing: 2 }); y = doc.y + 2;
  const sl = statusLine(d); if (sl) { doc.font('B').fontSize(8).fillColor(d.pay.status === 'voided' ? '#b3261e' : '#b26a00').text(sl, m, y, { width: W - 2 * m, align: 'center' }); y = doc.y; }
  y += 6; doc.font('R').fontSize(9).fillColor('#222');
  const kv = (k: string, v: string, x: number, yy: number, w: number) => { doc.font('R').fontSize(7.5).fillColor('#777').text(k.toUpperCase(), x, yy, { width: w }); doc.font('B').fontSize(9.5).fillColor('#111').text(v, x, doc.y, { width: w }); };
  const half = (W - 2 * m) / 2; const y0 = y;
  kv('Receipt no', d.pay.receiptNo, m, y0, half - 6); kv('Date', dateFmt(d.pay.paidAt), m + half, y0, half - 6); y = Math.max(doc.y, y0 + 28) + 6; const y1 = y;
  kv('Received from', `${d.learner.name} (${d.learner.code})`, m, y1, half - 6); kv('Paid by', `${cap(d.pay.method)}${d.pay.reference ? ` · ${d.pay.reference}` : ''}`, m + half, y1, half - 6); y = Math.max(doc.y, y1 + 28) + 4;
  if (d.learner.parent) { doc.font('R').fontSize(8).fillColor('#555').text(`Parent / guardian: ${d.learner.parent}`, m, y, { width: W - 2 * m }); y = doc.y + 4; }
  doc.rect(m, y, W - 2 * m, 18).fillColor(a).fill(); doc.font('B').fontSize(8.5).fillColor('#fff').text('PAID TOWARDS', m + 6, y + 5).text('AMOUNT', m, y + 5, { width: W - 2 * m - 6, align: 'right' }); y += 22;
  doc.font('R').fontSize(9).fillColor('#111');
  for (const l of d.lines) { doc.text(`${l.title} · ${l.label}`, m + 6, y, { width: W - 2 * m - 90 }); doc.text(rupees(l.amount), m, y, { width: W - 2 * m - 6, align: 'right' }); y = Math.max(doc.y, y + 12) + 3; }
  if (d.pay.credit > 0) { doc.text('Advance / credit', m + 6, y); doc.text(rupees(d.pay.credit), m, y, { width: W - 2 * m - 6, align: 'right' }); y = doc.y + 3; }
  doc.moveTo(m, y).lineTo(W - m, y).lineWidth(0.5).strokeColor('#bbb').stroke(); y += 6;
  doc.font('B').fontSize(12).fillColor('#111').text('Amount received', m + 6, y).text(rupees(d.pay.amount), m, y, { width: W - 2 * m - 6, align: 'right' }); y = doc.y + 3;
  doc.font('R').fontSize(8).fillColor('#555').text(amountInWords(d.pay.amount), m + 6, y, { width: W - 2 * m - 12 }); y = doc.y + 6;
  if (d.fees.length) {
    doc.font('R').fontSize(8.5).fillColor('#333'); const row = (k: string, v: string, bold = false) => { doc.font(bold ? 'B' : 'R').text(k, m + 6, y, { width: 200 }).text(v, m, y, { width: W - 2 * m - 6, align: 'right' }); y = doc.y + 1.5; };
    row('Fee', rupees(t.gross)); if (t.discount > 0) row('Discount given', `− ${rupees(t.discount)}`); row('Fee after discount', rupees(t.net)); row('Paid so far (with this receipt)', rupees(t.paid)); row('Balance due', rupees(t.balance), true); y += 3;
    if (d.fees.some((f) => f.level)) { doc.font('R').fontSize(7.5).fillColor('#777').text(`Level: ${[...new Set(d.fees.map((f) => f.level).filter(Boolean))].join(', ')}`, m + 6, y); y = doc.y + 2; }
  }
  if (d.pay.refunded > 0 && d.pay.status !== 'voided') { doc.font('R').fontSize(8.5).fillColor('#b3261e').text(`Refunded: ${rupees(d.pay.refunded)}`, m + 6, y); y = doc.y + 2; }
  if (d.pay.status === 'voided' && d.pay.voidReason) { doc.font('R').fontSize(8.5).fillColor('#b3261e').text(`Cancelled: ${d.pay.voidReason}`, m + 6, y, { width: W - 2 * m - 12 }); }
  const fy = H - 92; doc.font('R').fontSize(7.5).fillColor('#666');
  if (d.org.footer) doc.text(d.org.footer, m + 6, fy - 22, { width: W - 2 * m - 130, height: 30 });
  doc.moveTo(W - m - 110, fy + 10).lineTo(W - m - 6, fy + 10).lineWidth(0.5).strokeColor('#777').stroke();
  doc.text(d.org.signatory ?? 'Authorised signatory', W - m - 116, fy + 13, { width: 116, align: 'center' }); if (d.org.signatoryTitle) doc.text(d.org.signatoryTitle, W - m - 116, doc.y, { width: 116, align: 'center' });
  doc.fontSize(7).fillColor('#999').text('This is a computer generated receipt.', m, H - 44, { width: W - 2 * m, align: 'center' });
  if (d.pay.status === 'voided') stamp(doc, 'CANCELLED', '#b3261e');
}

function modern(doc: PDFKit.PDFDocument, d: ReceiptData) {
  const W = doc.page.width; const H = doc.page.height; const m = 30; const a = d.org.accent; const t = totals(d);
  doc.rect(0, 0, W, 92).fillColor(a).fill(); doc.rect(0, 92, W, 5).fillColor('#f5a524').opacity(0.9).fill(); doc.opacity(1);
  let x = m; if (d.org.logo) { try { doc.save().roundedRect(m, 20, 52, 52, 10).clip(); doc.rect(m, 20, 52, 52).fillColor('#fff').fill(); doc.image(d.org.logo, m + 4, 24, { fit: [44, 44] }); doc.restore(); x = m + 62; } catch { /* skip */ } }
  doc.font('B').fontSize(16).fillColor('#fff').text(d.org.name, x, 24, { width: W - x - m - 90 }); doc.font('R').fontSize(8).fillColor('#ffffffcc');
  if (d.org.header) doc.text(d.org.header, x, doc.y, { width: W - x - m - 90 }); if (d.org.address) doc.text(d.org.address, x, doc.y, { width: W - x - m - 90 });
  doc.font('B').fontSize(9).fillColor('#fff').text('RECEIPT', W - m - 100, 26, { width: 100, align: 'right', characterSpacing: 2 }); doc.font('R').fontSize(8).text(d.pay.receiptNo, W - m - 120, 40, { width: 120, align: 'right' }).text(dateFmt(d.pay.paidAt), W - m - 120, doc.y, { width: 120, align: 'right' });
  let y = 112; const sl = statusLine(d);
  doc.roundedRect(m, y, W - 2 * m, 62, 10).fillColor('#f4f7fb').fill();
  doc.font('R').fontSize(8).fillColor('#667').text('AMOUNT RECEIVED', m + 14, y + 10); doc.font('B').fontSize(24).fillColor(a).text(rupees(d.pay.amount), m + 14, y + 22, { width: W - 2 * m - 120 });
  const chipText = d.pay.status === 'voided' ? 'CANCELLED' : 'PAID'; const chipColor = d.pay.status === 'voided' ? '#b3261e' : '#0e8f6e'; doc.roundedRect(W - m - 96, y + 18, 82, 26, 13).fillColor(chipColor).fill(); doc.font('B').fontSize(10).fillColor('#fff').text(chipText, W - m - 96, y + 26, { width: 82, align: 'center' });
  y += 72; doc.font('R').fontSize(8).fillColor('#667').text(amountInWords(d.pay.amount), m, y, { width: W - 2 * m }); y = doc.y + 4; if (sl) { doc.font('B').fontSize(8).fillColor(d.pay.status === 'voided' ? '#b3261e' : '#b26a00').text(sl, m, y); y = doc.y + 4; }
  y += 6; const col = (W - 2 * m) / 2;
  const kv = (k: string, v: string, xx: number, yy: number) => { doc.font('R').fontSize(7.5).fillColor('#889').text(k.toUpperCase(), xx, yy, { width: col - 8 }); doc.font('B').fontSize(10).fillColor('#111').text(v, xx, doc.y, { width: col - 8 }); };
  kv('Received from', d.learner.name, m, y); kv('Learner ID', d.learner.code, m + col, y); y = Math.max(doc.y, y + 30) + 6; kv('Paid by', cap(d.pay.method), m, y); kv('Reference', d.pay.reference ?? '—', m + col, y); y = Math.max(doc.y, y + 30) + 8;
  doc.moveTo(m, y).lineTo(W - m, y).lineWidth(0.6).strokeColor('#dde3ec').stroke(); y += 8;
  doc.font('B').fontSize(8).fillColor('#667').text('PAID TOWARDS', m, y); y = doc.y + 4; doc.font('R').fontSize(9.5).fillColor('#111');
  for (const l of d.lines) { doc.text(`${l.title}`, m, y, { width: W - 2 * m - 90 }); doc.fontSize(7.5).fillColor('#778').text(l.label, m, doc.y); doc.fontSize(9.5).fillColor('#111').text(rupees(l.amount), m, y, { width: W - 2 * m, align: 'right' }); y = Math.max(doc.y, y + 22) + 4; }
  if (d.pay.credit > 0) { doc.text('Advance / credit', m, y).text(rupees(d.pay.credit), m, y, { width: W - 2 * m, align: 'right' }); y = doc.y + 4; }
  if (d.fees.length) {
    y += 2; doc.roundedRect(m, y, W - 2 * m, t.discount > 0 ? 64 : 50, 8).fillColor('#fafbfd').fill(); let yy = y + 8; const row = (k: string, v: string, bold = false, color = '#333') => { doc.font(bold ? 'B' : 'R').fontSize(8.5).fillColor(color).text(k, m + 12, yy, { width: 200 }).text(v, m, yy, { width: W - 2 * m - 12, align: 'right' }); yy = doc.y + 2; };
    row('Fee', rupees(t.gross)); if (t.discount > 0) row('Discount given', `− ${rupees(t.discount)}`, false, '#0e8f6e'); row('Paid so far', rupees(t.paid)); row('Balance due', rupees(t.balance), true, t.balance > 0 ? '#b26a00' : '#0e8f6e'); y = yy + 10;
  }
  if (d.pay.status === 'voided' && d.pay.voidReason) { doc.font('R').fontSize(8.5).fillColor('#b3261e').text(`Cancelled: ${d.pay.voidReason}`, m, y, { width: W - 2 * m }); }
  const fy = H - 78; if (d.org.footer) doc.font('R').fontSize(7.5).fillColor('#778').text(d.org.footer, m, fy - 14, { width: W - 2 * m - 130, height: 28 });
  if (d.org.taxId) doc.font('R').fontSize(7.5).fillColor('#778').text(`GSTIN / Reg. no: ${d.org.taxId}`, m, fy + 18, { width: 200 });
  doc.moveTo(W - m - 110, fy + 10).lineTo(W - m, fy + 10).lineWidth(0.5).strokeColor('#99a').stroke(); doc.font('R').fontSize(7.5).fillColor('#667').text(d.org.signatory ?? 'Authorised signatory', W - m - 116, fy + 13, { width: 116, align: 'center' });
  doc.rect(0, H - 22, W, 22).fillColor(a).fill(); doc.font('R').fontSize(7).fillColor('#ffffffcc').text('Computer generated receipt · thank you', 0, H - 15, { width: W, align: 'center' });
  if (d.pay.status === 'voided') stamp(doc, 'CANCELLED', '#b3261e');
}

function slip(doc: PDFKit.PDFDocument, d: ReceiptData) {
  const W = doc.page.width; const m = 14; const w = W - 2 * m; const t = totals(d); let y = 14;
  const dash = () => { doc.dash(2, { space: 2 }).moveTo(m, y).lineTo(W - m, y).lineWidth(0.5).strokeColor('#555').stroke().undash(); y += 6; };
  if (d.org.logo) { try { doc.image(d.org.logo, W / 2 - 18, y, { fit: [36, 36] }); y += 40; } catch { /* skip */ } }
  doc.font('B').fontSize(11).fillColor('#000').text(d.org.name, m, y, { width: w, align: 'center' }); y = doc.y; doc.font('R').fontSize(7).fillColor('#333');
  if (d.org.header) { doc.text(d.org.header, m, y, { width: w, align: 'center' }); y = doc.y; } if (d.org.address) { doc.text(d.org.address, m, y, { width: w, align: 'center' }); y = doc.y; } if (d.org.taxId) { doc.text(`GSTIN / Reg: ${d.org.taxId}`, m, y, { width: w, align: 'center' }); y = doc.y; }
  y += 4; dash(); doc.font('B').fontSize(9).fillColor('#000').text('FEE RECEIPT', m, y, { width: w, align: 'center' }); y = doc.y; const sl = statusLine(d); if (sl) { doc.font('B').fontSize(7).fillColor(d.pay.status === 'voided' ? '#b3261e' : '#8a5300').text(sl, m, y, { width: w, align: 'center' }); y = doc.y; } y += 3;
  const row = (k: string, v: string, bold = false) => { doc.font('R').fontSize(7.5).fillColor('#444').text(k, m, y, { width: 70 }); doc.font(bold ? 'B' : 'R').fillColor('#000').text(v, m + 72, y, { width: w - 72, align: 'right' }); y = doc.y + 1.5; };
  row('Receipt', d.pay.receiptNo); row('Date', dateFmt(d.pay.paidAt)); row('Name', d.learner.name); row('ID', d.learner.code); row('Paid by', `${cap(d.pay.method)}${d.pay.reference ? ` ${d.pay.reference}` : ''}`); y += 2; dash();
  doc.font('B').fontSize(7.5).fillColor('#000').text('PAID TOWARDS', m, y); y = doc.y + 2; for (const l of d.lines) { doc.font('R').fontSize(7.5).fillColor('#000').text(`${l.title} · ${l.label}`, m, y, { width: w - 56 }); doc.text(rupees(l.amount), m, y, { width: w, align: 'right' }); y = Math.max(doc.y, y + 10) + 2; }
  if (d.pay.credit > 0) row('Advance', rupees(d.pay.credit)); y += 2; dash();
  doc.font('B').fontSize(11).fillColor('#000').text('TOTAL', m, y).text(rupees(d.pay.amount), m, y, { width: w, align: 'right' }); y = doc.y + 2; doc.font('R').fontSize(6.5).fillColor('#444').text(amountInWords(d.pay.amount), m, y, { width: w }); y = doc.y + 4;
  if (d.fees.length) { dash(); if (t.discount > 0) row('Discount', `− ${rupees(t.discount)}`); row('Fee', rupees(t.net)); row('Paid so far', rupees(t.paid)); row('Balance', rupees(t.balance), true); y += 2; }
  if (d.pay.status === 'voided' && d.pay.voidReason) { doc.font('R').fontSize(7).fillColor('#b3261e').text(`Cancelled: ${d.pay.voidReason}`, m, y, { width: w }); y = doc.y + 2; }
  dash(); if (d.org.footer) { doc.font('R').fontSize(6.5).fillColor('#444').text(d.org.footer, m, y, { width: w, align: 'center' }); y = doc.y + 4; }
  doc.font('R').fontSize(6.5).fillColor('#666').text('Computer generated receipt · thank you', m, y, { width: w, align: 'center' });
  if (d.pay.status === 'voided') stamp(doc, 'CANCELLED', '#b3261e');
}

export const receiptFileName = (no: string) => `${String(no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
export { fromPaise };
