-- Add index to support ORDER BY createdAt without full table sort
CREATE INDEX `idx_job_createdAt` ON `Job`(`createdAt`);

