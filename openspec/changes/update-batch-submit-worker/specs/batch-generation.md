## ADDED Requirements

- System MUST move Gemini Batch API submission for Automatic mode from Next.js API routes to RunPod worker to avoid frontend timeout.
- Worker MUST support chunking batch requests so that each JSONL payload stays under Gemini inline/file limits (e.g., <20MB per file) and can create multiple batch jobs for one app job when needed.
- Worker MUST send a webhook response back immediately after batch submission containing `job_id`, `status=batch_submitted`, and the list of `batch_job_names`; worker MUST NOT poll batch status.
- Next.js MUST provide an authenticated server endpoint `/api/jobs/[id]/check-batch` that, when triggered, queries Gemini Batch API for stored `batch_job_names`, fetches outputs, uploads generated images to GCS (when configured), and updates the Job record to `completed` or `failed`.
- UI MUST allow users to trigger the new check endpoint (e.g., “Check batch status” button) and refresh the job detail view with updated results.

#### Scenario: Worker submits batch and returns immediately
- Given a job with many prompt/image combinations
- When Next.js enqueues it to RunPod
- Then worker chunks requests, uploads JSONL, calls `batches.create`, and sends a webhook with `batch_job_names` and `status=batch_submitted` without polling.

#### Scenario: User checks batch completion
- Given a job in status `batch_submitted` with stored `batch_job_names`
- When the user clicks “Check batch status”
- Then `/api/jobs/[id]/check-batch` queries Gemini Batch, downloads results, stores images (GCS if enabled), writes results to DB, and sets status `completed` (or `failed` on error).
