const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "..", "docs", "specbooks-partner-guide.md");
const outputPath = path.join(__dirname, "..", "docs", "SpecBooks-Partner-Guide.pdf");

const raw = fs.readFileSync(inputPath, "utf8");
const sourceLines = raw.replace(/\r\n/g, "\n").split("\n");

function wrapLine(line, maxChars = 92) {
  if (line.length <= maxChars) return [line];
  const out = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < 1) cut = maxChars;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) out.push(remaining);
  return out;
}

const lines = [];
for (const line of sourceLines) {
  if (line.startsWith("```")) continue;
  lines.push(...wrapLine(line));
}

const pageWidth = 612;
const pageHeight = 792;
const marginLeft = 54;
const marginTop = 54;
const lineHeight = 13;
const usableHeight = pageHeight - marginTop * 2;
const linesPerPage = Math.floor(usableHeight / lineHeight);

const pages = [];
for (let i = 0; i < lines.length; i += linesPerPage) {
  pages.push(lines.slice(i, i + linesPerPage));
}

function escapePdfText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const objects = [];
const addObject = (body) => {
  objects.push(body);
  return objects.length;
};

const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
const pagesId = addObject("<< /Type /Pages /Kids [] /Count 0 >>");
const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

const pageIds = [];
const contentIds = [];

for (const pageLines of pages) {
  let stream = "BT\n/F1 10 Tf\n";
  let y = pageHeight - marginTop;
  for (const line of pageLines) {
    stream += `1 0 0 1 ${marginLeft} ${y} Tm (${escapePdfText(line)}) Tj\n`;
    y -= lineHeight;
  }
  stream += "ET\n";
  const contentBody = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`;
  const contentId = addObject(contentBody);
  const pageBody = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  const pageId = addObject(pageBody);
  contentIds.push(contentId);
  pageIds.push(pageId);
}

objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

let pdf = "%PDF-1.4\n";
const offsets = [0];

for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, "utf8"));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefStart = Buffer.byteLength(pdf, "utf8");
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

fs.writeFileSync(outputPath, pdf, "utf8");
console.log(`Wrote ${outputPath}`);

