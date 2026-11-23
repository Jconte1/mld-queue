import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, traceJobId, traceJobPoll, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { getJobById } from "@/lib/jobs";

async function pollJob(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    const { jobId } = await params;
    traceJobId(jobId);
    traceStage("poll_lookup");
    const job = await getJobById(jobId);
    traceJobPoll(jobId, job);

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
    traceRequestError(error);
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to fetch job" }, { status: 500 });
  }
}

export const GET = withSpecbooksRequest("POLL_JOB", pollJob);
