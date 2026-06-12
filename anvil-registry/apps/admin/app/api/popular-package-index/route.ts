import { NextResponse, type NextRequest } from "next/server";
import { loadActivePopularPackageIndex } from "@anvilstack/name-squatting";
import { config, getObjectStore } from "@/lib/admin-data";
import { requireApiAdmin, uploadPopularPackageIndex } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;
  const index = await loadActivePopularPackageIndex({
    objectStore: getObjectStore(),
    objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
    indexPath: config.POPULAR_PACKAGE_INDEX_PATH
  });
  return NextResponse.json(index);
}

export async function POST(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;
  return uploadPopularPackageIndex((await request.json()) as Record<string, unknown>);
}
