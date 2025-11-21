## 1. Project Setup
- [ ] 1.1 Update `openspec/project.md` with project context (Next.js, TypeScript, RunPod Serverless, Banana Gemini)
- [ ] 1.2 Install required dependencies (if any new packages needed)

## 2. RunPod Serverless Worker
- [ ] 2.1 Create `worker/` directory structure
- [ ] 2.2 Create Python handler function for RunPod Serverless (based on `gemini-2.5-flash-image-preview-api.py`)
- [ ] 2.3 Implement handler for Automatic mode (batch processing)
- [ ] 2.4 Implement handler for Semi-Automatic mode (controlled batches)
- [ ] 2.5 Add error handling and retry logic
- [ ] 2.6 Create Dockerfile for worker deployment
- [ ] 2.7 Add requirements.txt for Python dependencies

## 3. Next.js API Routes
- [ ] 3.1 Create API route for job submission (`/api/jobs/submit`)
- [ ] 3.2 Create API route for job status (`/api/jobs/[id]/status`)
- [ ] 3.3 Create API route for job results (`/api/jobs/[id]/results`)
- [ ] 3.4 Create API route for queue management (`/api/queue`)
- [ ] 3.5 Create API route for group management (`/api/groups`)
- [ ] 3.6 Create API route for bulk download (`/api/download/[groupId]`)

## 4. Automatic Mode UI
- [ ] 4.1 Create page `/automatic` or route
- [ ] 4.2 Add file upload component for large image sets
- [ ] 4.3 Add basic prompt input field
- [ ] 4.4 Add processing status display
- [ ] 4.5 Add download button for completed batches

## 5. Semi-Automatic Mode UI
- [ ] 5.1 Create page `/semi-automatic` or route
- [ ] 5.2 Build Midjourney-like interface layout
- [ ] 5.3 Add group creation/selection UI
- [ ] 5.4 Add reference image upload (multiple images)
- [ ] 5.5 Add prompt input with image associations
- [ ] 5.6 Add batch size configuration (e.g., 40 images = 10 sets of 4)
- [ ] 5.7 Add queue display showing active/pending jobs
- [ ] 5.8 Add image generation settings panel

## 6. Queue Management
- [ ] 6.1 Implement queue data structure/storage
- [ ] 6.2 Add job queuing logic (parallel/consecutive execution)
- [ ] 6.3 Add job status tracking
- [ ] 6.4 Add queue UI component showing all jobs

## 7. Image Organization
- [ ] 7.1 Implement group data model
- [ ] 7.2 Add group creation API
- [ ] 7.3 Add group selection in UI
- [ ] 7.4 Ensure generated images are stored within their groups

## 8. Bulk Download
- [ ] 8.1 Implement ZIP file generation for image groups
- [ ] 8.2 Add bulk selection UI component
- [ ] 8.3 Add download endpoint that creates ZIP on-demand
- [ ] 8.4 Add progress indicator for large downloads

## 9. Integration & Testing
- [ ] 9.1 Test Automatic mode end-to-end
- [ ] 9.2 Test Semi-Automatic mode end-to-end
- [ ] 9.3 Test queue management with multiple jobs
- [ ] 9.4 Test bulk download functionality
- [ ] 9.5 Verify RunPod Serverless integration

## 10. Documentation
- [ ] 10.1 Document RunPod Serverless deployment process
- [ ] 10.2 Document API endpoints
- [ ] 10.3 Add usage instructions for both modes

