# Change: Update Batch Submission via RunPod Worker

## Why
- Gọi Batch API trực tiếp từ Next.js đang bị timeout do thời gian xử lý dài và payload lớn.
- Cần tách submit sang RunPod worker để tránh giới hạn thời gian của Next.js, cho phép chunk payload và giữ UI nhẹ.
- Giảm chi phí rảnh của worker: không poll dài hạn; batch status sẽ được kiểm tra theo yêu cầu từ Next.js khi người dùng bấm “Refresh/Check”.

## What Changes
- Next.js chỉ enqueue job automatic-batch: lưu DB rồi gửi payload tối thiểu sang RunPod.
- Worker tạo JSONL (chunk requests nếu vượt ngưỡng an toàn) và gọi Gemini Batch API; nhận `batch_job_name` và trả về ngay qua webhook cho Next.js (status `batch_submitted` + danh sách batch jobs).
- Next.js bổ sung endpoint `POST /api/jobs/[id]/check-batch` để khi user bấm nút sẽ query trạng thái Batch API và tải kết quả (sử dụng Gemini Files API) rồi cập nhật DB/results và (nếu cấu hình) upload GCS.
- UI cập nhật: nút “Check batch status” hoạt động; tải kết quả sau khi batch xong.

## Impact
- Affects capabilities: batch image generation, job lifecycle, worker-submit flow.
- Code areas: `app/api/jobs/submit-batch`, new `app/api/jobs/[id]/check-batch`, worker `rp_handler.py` (thêm đường submit batch + chunk JSONL), webhook handling, UI job detail.
- No DB schema change expected.
