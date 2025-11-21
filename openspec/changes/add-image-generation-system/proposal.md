# Change: Add Image Generation System

## Why
We need a comprehensive web application for generating image datasets using Banana Gemini API. The system should support two distinct workflows: Automatic mode for processing large batches (1000+ images) with minimal UI, and Semi-Automatic mode for controlled, interactive generation with Midjourney-like interface. This will enable efficient dataset creation for AI training and other use cases.

## What Changes
- Add Automatic mode: Simple upload interface for large image sets, batch processing via RunPod Serverless, and bulk download
- Add Semi-Automatic mode: Rich UI for controlled batch generation with prompts, reference images, and queue management
- Add queue management system: Support multiple concurrent/consecutive jobs with configurable batch sizes
- Add image organization: Group-based organization system to keep generated images organized
- Add RunPod Serverless worker: Python handler in `worker/` folder with Dockerfile for deployment
- Add Next.js API routes: Endpoints for job submission, status checking, and result retrieval
- Add bulk download functionality: ZIP file generation for completed image groups
- Add image generation settings: Support for multiple reference images with prompt associations and generation counts

## Impact
- Affected specs: New capabilities (image-generation, queue-management, image-organization)
- Affected code: 
  - New Next.js pages and API routes
  - New `worker/` directory with Python code and Dockerfile
  - Frontend components for both modes
  - Queue management system integration

