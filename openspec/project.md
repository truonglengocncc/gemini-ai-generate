# Project Context

## Purpose

The purpose of this project is to build a scalable web-based AI image generation platform that supports two main workflows: Automatic dataset augmentation and Semi-Automatic creative generation using multiple reference images and prompts. The system uses Nano Banana Gemini running on RunPod Serverless as the backend for compute, queuing, concurrency handling, and worker execution.

The goal is to allow users to upload images, configure prompts, generate image variations in organized groups, and download results in bulk. The system must support large datasets (e.g., 1,000+ images) in Automatic Mode and controlled batch generation in Semi-Automatic Mode (e.g., 4 images per run, 40-image batches, multiple queued jobs).

## Tech Stack

* Next.js (App Router)
* TypeScript
* React
* TailwindCSS or shadcn/ui (TBD)
* RunPod Serverless (Python workers)
* Docker (for worker deployment)
* Nano Banana Gemini (image generation model)
* Storage (local ZIP output first, optional Cloud bucket later)

## Project Conventions

### Code Style

* TypeScript first with strict mode enabled.
* Use React Server Components when possible.
* Follow Prettier + ESLint default formatting rules.
* Naming conventions:

  * `camelCase` for variables and functions
  * `PascalCase` for components and types
  * `UPPER_SNAKE_CASE` for environment variables
* Avoid large monolithic functions; use small composable utilities.

### Architecture Patterns

* **Frontend:** Next.js (App Router) following:

  * Server Actions for backend calls when appropriate
  * API routes for authenticated/long-running operations
  * Clean separation between UI, logic, and data fetching

* **Backend (RunPod Worker):**

  * Python serverless worker following RunPod handler function pattern
  * Task-based architecture:

    * `automatic_generation(task)`
    * `semi_auto_generation(task)`
  * Supports concurrency via RunPod concurrent handlers

* **Job Orchestration:**

  * Next.js sends jobs → RunPod queues and executes them
  * Polling for job status
  * Store results grouped by job/batch

* **Output Organization:**

  * Each job has its own group folder
  * ZIP file generation for download

### Testing Strategy

* Unit tests for:

  * Utility functions
  * Prompt processing logic
* Integration tests for:

  * API routes
  * Job submission flows
* Manual QA for:

  * Large dataset uploading
  * Multi-job queue behavior
  * Worker concurrency behavior (RunPod)

### Git Workflow

* Branching strategy:

  * `main` = stable, production-ready
  * `dev` = integration branch
  * Feature branches: `feat/feature-name`
  * Fix branches: `fix/issue-name`

* Commit conventions (Conventional Commits):

  * `feat:` new features
  * `fix:` bug fixes
  * `refactor:` code changes without behavior changes
  * `docs:` documentation
  * `chore:` tooling, dependencies

## Domain Context

* Image generation is powered by Nano Banana Gemini.
* Semi-Automatic Mode generates 4 images per inference; larger batches are split into multiple inference cycles.
* Automatic Mode generates variations for large datasets (1k+ images) based on a base prompt.
* Jobs must remain grouped and preserved for easier download and tracking.
* RunPod Serverless queues jobs automatically when concurrency is full.

## Important Constraints

* RunPod workers must be containerized via Docker.
* Concurrency is limited by RunPod plan; overflow jobs must be queued.
* Total input image size must respect RunPod payload limits.
* Workers must finish tasks within RunPod serverless max timeout.
* Large jobs must be broken into smaller chunks (e.g., 4-image runs).
* Output bundle size must remain manageable for download (ZIP).

## External Dependencies

* RunPod Serverless (compute, queueing, concurrency, job execution)
* Nano Banana Gemini (AI model for image generation)
* Cloud storage (optional future integration: AWS S3, GCS, or Supabase)
* Next.js built-in API routes
* Docker for worker deployment