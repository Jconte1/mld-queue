import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { getJobById } from "@/lib/jobs";

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    const { jobId } = await params;
    const job = await getJobById(jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json(
      {
        jobId: job.id,
        vendorId: job.vendorId,
        type: job.type,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to fetch job" }, { status: 500 });
  }
}