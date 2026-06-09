import { S3Client } from "@bradenmacdonald/s3-lite-client";

const sourceDir = Deno.args[0] ?? "/app/data/blobs";
const concurrency = positiveInt(Deno.env.get("MIGRATE_CONCURRENCY"), 3);

const endpoint = requiredEnv("S3_ENDPOINT");
const bucket = requiredEnv("S3_BUCKET");
const accessKey = requiredEnv("S3_ACCESS_KEY");
const secretKey = requiredEnv("S3_SECRET_KEY");
const region = Deno.env.get("S3_REGION") || "us-southeast-1";

const client = new S3Client({
  endPoint: endpoint,
  bucket,
  accessKey,
  secretKey,
  region,
  pathStyle: true,
});

type Totals = {
  scanned: number;
  uploaded: number;
  skipped: number;
  overwritten: number;
  errors: number;
  bytesUploaded: number;
};

const totals: Totals = {
  scanned: 0,
  uploaded: 0,
  skipped: 0,
  overwritten: 0,
  errors: 0,
  bytesUploaded: 0,
};

const keys: string[] = [];
for await (const entry of Deno.readDir(sourceDir)) {
  if (!entry.isFile) continue;
  if (!isBlobObjectKey(entry.name)) {
    console.warn(`skip non-blob file: ${entry.name}`);
    continue;
  }
  keys.push(entry.name);
}
keys.sort();

console.log(`migrating ${keys.length} Blossom blobs from ${sourceDir} to s3://${bucket}`);

let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const index = next++;
    if (index >= keys.length) break;
    await migrateOne(keys[index]!);
  }
}));

console.log(JSON.stringify(totals));
if (totals.errors > 0) Deno.exit(1);

async function migrateOne(key: string): Promise<void> {
  totals.scanned++;
  const path = `${sourceDir}/${key}`;
  try {
    const stat = await Deno.stat(path);
    const existing = await objectSize(key);
    if (existing === stat.size) {
      totals.skipped++;
      return;
    }

    const file = await Deno.open(path, { read: true });
    try {
      await client.putObject(key, file.readable, { size: stat.size });
    } finally {
      try {
        file.close();
      } catch {
        // The stream consumer may already have closed it.
      }
    }

    const uploaded = await objectSize(key);
    if (uploaded !== stat.size) {
      throw new Error(`uploaded size mismatch: local=${stat.size} remote=${uploaded ?? "missing"}`);
    }

    if (existing === null) totals.uploaded++;
    else totals.overwritten++;
    totals.bytesUploaded += stat.size;

    if ((totals.uploaded + totals.overwritten) % 100 === 0) {
      console.log(
        `progress scanned=${totals.scanned} uploaded=${totals.uploaded} overwritten=${totals.overwritten} skipped=${totals.skipped}`,
      );
    }
  } catch (err) {
    totals.errors++;
    console.error(`error ${key}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function objectSize(key: string): Promise<number | null> {
  try {
    const stat = await client.statObject(key);
    return typeof stat.size === "number" ? stat.size : null;
  } catch {
    return null;
  }
}

function isBlobObjectKey(name: string): boolean {
  return /^[0-9a-f]{64}(?:\.[A-Za-z0-9]+)?$/.test(name);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env var: ${name}`);
  return value;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
