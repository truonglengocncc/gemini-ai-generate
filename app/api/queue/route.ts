import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get("status");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "10");
    const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0");
    
    const where: any = {};
    if (status) {
      where.status = status;
    }

    // Get total count
    const total = await prisma.job.count({ where });

    // Get paginated jobs
    const jobs = await prisma.job.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
      skip: offset,
    });

    return NextResponse.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        mode: job.mode,
        groupId: job.groupId,
        status: job.status,
        createdAt: job.createdAt,
        error: job.error,
      })),
      total,
      hasMore: offset + limit < total,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

