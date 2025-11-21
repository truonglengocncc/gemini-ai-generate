## ADDED Requirements

### Requirement: Automatic Mode Image Generation
The system SHALL provide an Automatic mode for batch processing large image datasets (1000+ images) with minimal user interaction.

#### Scenario: Upload and process large image set
- **WHEN** user uploads a large image set (e.g., 1000 images) via Automatic mode interface
- **AND** user provides a basic prompt for image variations
- **THEN** system queues the job for processing
- **AND** system processes images in batches via RunPod Serverless worker
- **AND** system generates variations of each image based on the prompt
- **AND** system stores all generated images in a downloadable format

#### Scenario: Monitor processing status
- **WHEN** user submits an Automatic mode job
- **THEN** system displays processing status (queued, processing, completed)
- **AND** user can check progress of batch processing

#### Scenario: Download completed batch
- **WHEN** Automatic mode job completes processing
- **THEN** system provides download functionality for the completed image set
- **AND** user can download all generated images as a ZIP file

### Requirement: Semi-Automatic Mode Image Generation
The system SHALL provide a Semi-Automatic mode with Midjourney-like UI for controlled batch image generation.

#### Scenario: Create controlled batch generation
- **WHEN** user selects Semi-Automatic mode
- **AND** user creates or selects a group
- **AND** user uploads one or more reference images
- **AND** user provides prompts associated with each reference image
- **AND** user specifies number of images to generate per prompt
- **AND** user sets total batch size (e.g., 40 images = 10 sets of 4)
- **THEN** system queues the job for processing
- **AND** system generates images in controlled batches (e.g., 4 images at a time)
- **AND** system stores generated images within the specified group

#### Scenario: Multiple reference images with prompts
- **WHEN** user uploads multiple reference images in Semi-Automatic mode
- **AND** user associates different prompts with each reference image
- **AND** user specifies how many times to use each image with its prompt
- **THEN** system generates images according to the specified associations
- **AND** system respects the usage count for each image-prompt pair

#### Scenario: View generation results
- **WHEN** Semi-Automatic batch generation completes
- **THEN** system displays generated images within the group
- **AND** user can view all images generated for the batch
- **AND** images are organized by their associated prompts

### Requirement: Image Generation Settings
The system SHALL allow users to configure image generation parameters including reference images, prompts, and generation counts.

#### Scenario: Configure reference image usage
- **WHEN** user uploads reference images in Semi-Automatic mode
- **THEN** system allows user to specify how many times each image should be used
- **AND** user can associate multiple prompts with a single reference image
- **AND** user can set different generation counts for each prompt-image combination

#### Scenario: Batch size configuration
- **WHEN** user creates a Semi-Automatic generation job
- **THEN** system allows user to specify total number of images to generate
- **AND** system automatically calculates number of batches needed (e.g., 40 images with 4 per batch = 10 batches)
- **AND** system executes batches sequentially or in parallel based on queue capacity

### Requirement: Banana Gemini API Integration
The system SHALL integrate with Banana Gemini API for actual image generation using the gemini-2.5-flash-image-preview model.

#### Scenario: Generate image via Banana Gemini
- **WHEN** worker receives a generation request
- **THEN** worker calls Banana Gemini API with reference image and prompt
- **AND** worker uses gemini-2.5-flash-image-preview model
- **AND** worker handles API responses and errors appropriately
- **AND** worker saves generated images to storage

#### Scenario: Handle API errors
- **WHEN** Banana Gemini API call fails
- **THEN** worker implements retry logic with exponential backoff
- **AND** worker reports error status back to Next.js API
- **AND** job status is updated to reflect failure

