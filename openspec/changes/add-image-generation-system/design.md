## Context
We are building an image generation web application using Banana Gemini API. The system needs to handle two distinct use cases:
1. **Automatic Mode**: Process large datasets (1000+ images) with minimal user interaction
2. **Semi-Automatic Mode**: Provide fine-grained control over image generation with Midjourney-like UX

The application uses Next.js for frontend, RunPod Serverless for background processing, and integrates with Banana Gemini API for actual image generation.

## Goals / Non-Goals

### Goals
- Support batch processing of large image sets (Automatic mode)
- Provide interactive UI for controlled generation (Semi-Automatic mode)
- Enable queue management for multiple concurrent/consecutive jobs
- Organize generated images by groups
- Support bulk operations (download, cloud bucket assignment)
- Handle async processing via RunPod Serverless

### Non-Goals
- Real-time image streaming (images are generated asynchronously)
- Image editing capabilities (focus on generation only)
- User authentication (can be added later)
- Payment processing (out of scope)

## Decisions

### Decision: Use RunPod Serverless for Background Processing
**Rationale**: RunPod Serverless provides scalable, cost-effective serverless workers perfect for async image generation tasks. It supports concurrent handlers and integrates well with Python-based image processing.

**Alternatives considered**:
- Vercel Serverless Functions: Limited execution time, not ideal for long-running tasks
- Self-hosted queue system: Requires infrastructure management
- Direct API calls from Next.js: Would block requests and timeout

### Decision: Separate Worker Directory with Dockerfile
**Rationale**: RunPod Serverless requires containerized workers. Keeping worker code separate maintains clean separation of concerns and allows independent deployment.

**Structure**:
```
worker/
├── handler.py          # RunPod handler function
├── gemini_client.py    # Banana Gemini API client
├── requirements.txt    # Python dependencies
└── Dockerfile          # Container definition
```

### Decision: Two Distinct UI Modes
**Rationale**: Automatic and Semi-Automatic modes serve different use cases with different UX requirements. Separating them provides better user experience for each workflow.

**Implementation**:
- Automatic: Simple page with upload, basic prompt, status, download
- Semi-Automatic: Rich interface with groups, multiple ref images, prompts, queue display

### Decision: Group-Based Organization
**Rationale**: Users need to organize generated images logically. Groups provide natural boundaries for organization and bulk operations.

**Data Model**:
- Group: { id, name, createdAt, images: [] }
- Images stored within group directory structure

### Decision: Queue Management in Next.js API Routes
**Rationale**: Queue state can be managed in-memory or via database. For MVP, we'll use in-memory with option to migrate to database later.

**Queue Structure**:
- Job: { id, groupId, mode, status, config, results, createdAt }
- Queue: Array of jobs with status tracking

### Decision: ZIP Download for Bulk Operations
**Rationale**: ZIP files are standard for bulk downloads and work well for image groups. Cloud bucket integration can be added later.

**Implementation**:
- Generate ZIP on-demand when download requested
- Include all images from selected group(s)
- Stream ZIP file to client

## Risks / Trade-offs

### Risk: RunPod Serverless Cold Starts
**Mitigation**: Use concurrent handlers and keep workers warm with periodic health checks

### Risk: Large Image Sets Memory Issues
**Mitigation**: Process images in batches, stream results, use temporary storage

### Risk: Queue State Loss on Server Restart
**Mitigation**: For MVP, accept this limitation. Future: migrate to persistent storage (database)

### Trade-off: In-Memory Queue vs Database
**Chosen**: In-memory for simplicity. Can migrate to database if needed for persistence.

## Migration Plan

### Phase 1: MVP
- Basic Automatic mode
- Basic Semi-Automatic mode
- Simple queue (in-memory)
- ZIP download

### Phase 2: Enhancements
- Database-backed queue
- Cloud bucket integration
- User authentication
- Advanced queue management (priority, scheduling)

## Open Questions
- What is the maximum batch size for RunPod Serverless handlers?
- Should we implement rate limiting for API calls?
- Do we need image preview before download?
- Should groups support nested organization?

