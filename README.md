# AI Image Generation Platform

A web application for generating image datasets using Banana Gemini API with two modes: Automatic (batch processing) and Semi-Automatic (controlled generation).

## Features

### Automatic Mode
- Upload large image sets (1000+ images)
- Batch process with a single prompt
- Simple UI for upload, process, and download
- Automatic group creation and organization

### Semi-Automatic Mode
- Midjourney-like interface
- Multiple reference images with associated prompts
- Configurable batch sizes (e.g., 40 images = 10 sets of 4)
- Queue management for multiple concurrent jobs
- Group-based organization

### Job Management
- View all generated jobs with status
- Real-time status updates via webhook
- Filter jobs by status
- Pagination support

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React, TypeScript, TailwindCSS
- **Backend**: Next.js API Routes
- **Database**: MySQL with Prisma ORM
- **Worker**: Python (RunPod Serverless)
- **Image Generation**: Banana Gemini API (gemini-2.5-flash-image-preview)
- **Storage**: Google Cloud Storage (GCS) for generated images

## Setup

### Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- MySQL database
- RunPod account (for serverless workers)
- Google Gemini API key
- Google Cloud Storage account (optional, for image storage)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add:
```
DATABASE_URL="mysql://user:password@localhost:3306/ai_generate_image"
GEMINI_API_KEY=your_gemini_api_key
RUNPOD_ENDPOINT=your_runpod_endpoint_url
RUNPOD_API_KEY=your_runpod_api_key
WEBHOOK_URL=https://your-domain.com/api/webhook/runpod

# Optional: GCS Configuration
GCS_SERVICE_ACCOUNT_KEY={"type":"service_account",...}  # JSON string
GCS_BUCKET_NAME=your-bucket-name
GCS_PATH_PREFIX=generated-images/  # Optional path prefix
```

3. Set up database:
```bash
# Generate Prisma Client
npm run db:generate

# Push schema to database (for development)
npm run db:push

# Or create migration (for production)
npm run db:migrate
```

4. Run development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## RunPod Serverless Worker Setup

1. Build Docker image:
```bash
cd worker
docker build -t image-generation-worker .
```

2. Deploy to RunPod:
   - Push image to container registry (Docker Hub, etc.)
   - Create RunPod Serverless endpoint
   - Configure handler function: `handler.handler`
   - Set environment variable: `GEMINI_API_KEY`
   - Configure webhook URL: `https://your-domain.com/api/webhook/runpod`

3. Update `.env` with your RunPod endpoint URL and webhook URL

## Database Schema

### Group
- `id`: Unique identifier
- `name`: Group name
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp

### Job
- `id`: Unique identifier
- `groupId`: Foreign key to Group
- `mode`: "automatic" or "semi-automatic"
- `status`: "queued", "processing", "completed", "failed"
- `images`: Array of image URLs
- `prompts`: JSON data (prompts configuration)
- `config`: JSON data (job configuration)
- `runpodJobId`: RunPod job ID for tracking
- `results`: JSON data (generation results)
- `error`: Error message if failed
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp
- `completedAt`: Completion timestamp

## API Endpoints

### Jobs
- `POST /api/jobs/submit` - Submit a new generation job
- `GET /api/jobs` - List all jobs (with filters: ?status=completed&groupId=xxx&page=1&limit=20)
- `GET /api/jobs/[id]` - Get job details

### Groups
- `POST /api/groups` - Create a new group
- `GET /api/groups` - List all groups

### Webhook
- `POST /api/webhook/runpod` - Receive job completion callbacks from RunPod
- `GET /api/webhook/runpod` - Webhook health check

### Download
- `GET /api/download/[groupId]` - Get download URLs for group images

## Webhook Configuration

RunPod Serverless will POST to `/api/webhook/runpod` when a job completes. The webhook receives:
- `id`: RunPod job ID
- `status`: Job status ("COMPLETED" or "FAILED")
- `output`: Job results (if completed)
- `error`: Error message (if failed)

The webhook automatically updates the job status and results in the database.

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── jobs/          # Job submission and status
│   │   │   ├── submit/     # Submit new job
│   │   │   └── [id]/       # Get job details
│   │   ├── groups/         # Group management
│   │   ├── webhook/        # RunPod webhook
│   │   │   └── runpod/     # Webhook endpoint
│   │   └── download/       # Bulk download
│   ├── automatic/          # Automatic mode UI
│   ├── semi-automatic/     # Semi-automatic mode UI
│   ├── jobs/               # Jobs list page
│   └── page.tsx           # Home page
├── lib/
│   └── prisma.ts           # Prisma client instance
├── prisma/
│   └── schema.prisma       # Database schema
├── worker/
│   ├── rp_handler.py       # RunPod Serverless handler
│   ├── requirements.txt    # Python dependencies
│   └── Dockerfile          # Docker configuration
└── openspec/               # OpenSpec change proposals
```

## Usage

### Automatic Mode

1. Navigate to `/automatic`
2. Create or select a group
3. Upload multiple images
4. Enter a prompt for variations
5. Click "Generate Images"
6. Wait for processing to complete
7. Download results as ZIP

### Semi-Automatic Mode

1. Navigate to `/semi-automatic`
2. Create or select a group
3. Upload reference images
4. Add prompts for each image
5. Configure batch size and images per batch
6. Submit jobs (multiple batches will be queued)
7. Monitor queue status
8. Download completed groups

### View Jobs

1. Navigate to `/jobs`
2. View all jobs with status, mode, and generation count
3. Filter by status (queued, processing, completed, failed)
4. Jobs auto-refresh every 5 seconds

## Development

### Database Commands

```bash
# Generate Prisma Client
npm run db:generate

# Push schema changes (development)
npm run db:push

# Create migration (production)
npm run db:migrate

# Open Prisma Studio (database GUI)
npm run db:studio
```

### Running Tests

```bash
npm run lint
```

### Building for Production

```bash
npm run build
npm start
```

## Notes

- Jobs are stored in MySQL database with Prisma ORM
- Generated images are uploaded to GCS (if configured) or returned as base64
- Webhook automatically updates job status when RunPod completes processing
- For production, ensure webhook URL is publicly accessible
- Consider adding authentication/authorization for production use

## License

MIT
