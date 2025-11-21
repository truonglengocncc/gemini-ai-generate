# Docker Setup cho MySQL

Hướng dẫn chạy MySQL database bằng Docker Compose.

## Yêu cầu

- Docker và Docker Compose đã được cài đặt

## Cách sử dụng

### 1. Khởi động MySQL container

```bash
docker-compose up -d
```

Lệnh này sẽ:
- Tải MySQL 8.0 image (nếu chưa có)
- Tạo và khởi động container `ai-generate-image-mysql`
- Tạo database `ai_generate_image` tự động
- Expose port 3306 để kết nối từ host

### 2. Kiểm tra container đang chạy

```bash
docker-compose ps
```

### 3. Xem logs

```bash
docker-compose logs -f mysql
```

### 4. Push Prisma schema vào database

```bash
npm run db:push
```

### 5. Dừng container

```bash
docker-compose down
```

### 6. Dừng và xóa data (reset database)

```bash
docker-compose down -v
```

## Cấu hình

- **Database name**: `ai_generate_image`
- **Username**: `aiuser`
- **Password**: `aipassword`
- **Root password**: `rootpassword` (chỉ dùng cho admin)
- **Port**: `3306`
- **Data persistence**: Data được lưu trong Docker volume `mysql_data`

## DATABASE_URL

File `.env` đã được cấu hình với:
```
DATABASE_URL="mysql://aiuser:aipassword@localhost:3306/ai_generate_image"
```

**Lưu ý**: Bạn có thể thay đổi username và password trong `docker-compose.yml` và cập nhật `.env` tương ứng.

## Troubleshooting

### Port 3306 đã được sử dụng

Nếu port 3306 đã bị chiếm (ví dụ XAMPP đang chạy), có thể đổi port trong `docker-compose.yml`:

```yaml
ports:
  - "3307:3306"  # Thay đổi port bên trái (host port)
```

Và cập nhật `.env`:
```
DATABASE_URL="mysql://root@localhost:3307/ai_generate_image"
```

### Kiểm tra kết nối

```bash
# Từ WSL2
mysql -h localhost -P 3306 -u aiuser -paipassword ai_generate_image
```

### Reset database

```bash
docker-compose down -v
docker-compose up -d
npm run db:push
```

