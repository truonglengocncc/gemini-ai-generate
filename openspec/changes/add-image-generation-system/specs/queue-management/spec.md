## ADDED Requirements

### Requirement: Job Queue System
The system SHALL maintain a queue of image generation jobs that can run in parallel or consecutively.

#### Scenario: Submit multiple jobs to queue
- **WHEN** user submits multiple generation jobs (e.g., 40 images, 80 images, 100 images)
- **THEN** system adds all jobs to the queue
- **AND** system tracks each job with unique identifier
- **AND** system maintains job status (queued, processing, completed, failed)

#### Scenario: Execute jobs in parallel
- **WHEN** multiple jobs are queued
- **AND** system has capacity for parallel execution
- **THEN** system executes multiple jobs simultaneously via RunPod Serverless
- **AND** system tracks progress of each job independently

#### Scenario: Execute jobs consecutively
- **WHEN** system reaches maximum parallel capacity
- **THEN** system queues additional jobs for sequential execution
- **AND** system starts next job when a running job completes

### Requirement: Job Status Tracking
The system SHALL track and display the status of all queued and active jobs.

#### Scenario: View queue status
- **WHEN** user views Semi-Automatic mode interface
- **THEN** system displays all queued jobs with their status
- **AND** system shows job details (group, batch size, progress)
- **AND** system updates status in real-time as jobs progress

#### Scenario: Check job progress
- **WHEN** user requests status of a specific job
- **THEN** system returns current status (queued, processing, completed, failed)
- **AND** system includes progress information (e.g., 5/10 batches completed)
- **AND** system includes estimated completion time if available

### Requirement: Queue Management API
The system SHALL provide API endpoints for submitting jobs, checking status, and retrieving results.

#### Scenario: Submit job via API
- **WHEN** frontend calls `/api/jobs/submit` with job configuration
- **THEN** system validates job parameters
- **AND** system creates job record in queue
- **AND** system returns job ID to frontend
- **AND** system initiates processing via RunPod Serverless

#### Scenario: Check job status via API
- **WHEN** frontend calls `/api/jobs/[id]/status`
- **THEN** system returns current job status
- **AND** system includes progress information
- **AND** system includes error details if job failed

#### Scenario: Retrieve job results via API
- **WHEN** frontend calls `/api/jobs/[id]/results` for completed job
- **THEN** system returns list of generated image URLs or paths
- **AND** system includes metadata (prompts used, reference images, timestamps)

### Requirement: RunPod Serverless Integration
The system SHALL integrate with RunPod Serverless for executing image generation tasks asynchronously.

#### Scenario: Submit task to RunPod Serverless
- **WHEN** Next.js API receives job submission
- **THEN** system calls RunPod Serverless endpoint with job configuration
- **AND** system passes reference images, prompts, and generation parameters
- **AND** system receives handler response confirming task acceptance

#### Scenario: Handle RunPod Serverless response
- **WHEN** RunPod Serverless worker completes image generation
- **THEN** worker calls Next.js callback endpoint with results
- **AND** Next.js API updates job status to completed
- **AND** Next.js API stores generated image references
- **AND** system makes results available for download

#### Scenario: Handle RunPod Serverless errors
- **WHEN** RunPod Serverless worker encounters error
- **THEN** worker reports error to Next.js callback endpoint
- **AND** Next.js API updates job status to failed
- **AND** system stores error details for user review

