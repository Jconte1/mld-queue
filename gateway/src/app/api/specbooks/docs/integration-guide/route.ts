import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const pdfPath = path.resolve(
      process.cwd(),
      "..",
      "docs",
      "SpecBooks-Integration-API-Guide.pdf"
    );
    const buffer = await readFile(pdfPath);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition":
          'attachment; filename="SpecBooks-Integration-API-Guide.pdf"',
        "cache-control": "no-store"
      }
    });
  } catch {
    return NextResponse.json(
      { error: "Integration guide PDF not found" },
      { status: 404 }
    );
  }
}
